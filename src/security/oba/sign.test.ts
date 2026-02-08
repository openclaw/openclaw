import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncode } from "./base64url.js";
import { preparePayloadForSigning } from "./canonicalize.js";
import {
  deriveKid,
  generateObaKeyPair,
  listObaKeys,
  loadObaKey,
  publicKeyToJwkX,
  saveObaKey,
  signPayload,
} from "./keys.js";
import { isPrivateHost, validateOwnerUrl } from "./owner-url.js";
import {
  extractSkillMetadata,
  parseSkillMetadataObject,
  signPluginManifest,
  signSkillMetadata,
} from "./sign.js";
import { clearJwksCache, verifyObaContainer } from "./verify.js";

// Helper: generate a test keypair.
function makeTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { publicKeyPem, privateKeyPem };
}

describe("OBA key management", () => {
  let tmpDir: string;
  const origConfigDir = process.env.OPENCLAW_STATE_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oba-keys-test-"));
    process.env.OPENCLAW_STATE_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origConfigDir) {
      process.env.OPENCLAW_STATE_DIR = origConfigDir;
    } else {
      delete process.env.OPENCLAW_STATE_DIR;
    }
  });

  it("deriveKid produces a 16-char string", () => {
    const { publicKeyPem } = makeTestKeyPair();
    const kid = deriveKid(publicKeyPem);
    expect(kid).toHaveLength(16);
    expect(kid).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("deriveKid is deterministic", () => {
    const { publicKeyPem } = makeTestKeyPair();
    expect(deriveKid(publicKeyPem)).toBe(deriveKid(publicKeyPem));
  });

  it("publicKeyToJwkX produces a base64url string", () => {
    const { publicKeyPem } = makeTestKeyPair();
    const x = publicKeyToJwkX(publicKeyPem);
    expect(x).toMatch(/^[A-Za-z0-9_-]+$/);
    // Ed25519 raw key is 32 bytes → 43 base64url chars.
    expect(x).toHaveLength(43);
  });

  it("generateObaKeyPair creates valid key file", () => {
    const key = generateObaKeyPair("https://example.com/jwks.json");
    expect(key.kid).toHaveLength(16);
    expect(key.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(key.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(key.owner).toBe("https://example.com/jwks.json");
    expect(key.createdAt).toBeTruthy();
  });

  it("signPayload produces valid Ed25519 signature", () => {
    const { publicKeyPem, privateKeyPem } = makeTestKeyPair();
    const payload = Buffer.from("test payload", "utf-8");
    const sig = signPayload(payload, privateKeyPem);
    expect(sig).toBeInstanceOf(Buffer);
    expect(sig.length).toBe(64); // Ed25519 signatures are 64 bytes.
    // Verify with public key.
    const valid = crypto.verify(null, payload, publicKeyPem, sig);
    expect(valid).toBe(true);
  });

  it("saveObaKey + loadObaKey round-trips", () => {
    const key = generateObaKeyPair("https://example.com/jwks.json");
    saveObaKey(key);
    const loaded = loadObaKey(key.kid);
    expect(loaded.kid).toBe(key.kid);
    expect(loaded.publicKeyPem).toBe(key.publicKeyPem);
    expect(loaded.privateKeyPem).toBe(key.privateKeyPem);
    expect(loaded.owner).toBe(key.owner);
    expect(loaded.createdAt).toBe(key.createdAt);
  });

  it("listObaKeys returns saved keys", () => {
    const before = listObaKeys();
    const key1 = generateObaKeyPair("https://example.com/jwks1.json");
    const key2 = generateObaKeyPair("https://example.com/jwks2.json");
    saveObaKey(key1);
    saveObaKey(key2);
    const after = listObaKeys();
    expect(after.length).toBe(before.length + 2);
    const kids = after.map((k) => k.kid);
    expect(kids).toContain(key1.kid);
    expect(kids).toContain(key2.kid);
  });

  it("loadObaKey rejects path traversal", () => {
    expect(() => loadObaKey("../../../etc/passwd")).toThrow("Invalid key ID");
    expect(() => loadObaKey("foo/bar")).toThrow("Invalid key ID");
  });
});

describe("OBA plugin signing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oba-sign-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("signs a plugin manifest and produces valid oba block", () => {
    const manifest = { id: "test-plugin", configSchema: { type: "object" } };
    const manifestPath = path.join(tmpDir, "openclaw.plugin.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const key = generateObaKeyPair("https://example.com/jwks/test.json");
    const { kid, sig } = signPluginManifest({ manifestPath, key });

    expect(kid).toBe(key.kid);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);

    // Read back and verify structure.
    const signed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(signed.oba).toBeDefined();
    expect(signed.oba.owner).toBe("https://example.com/jwks/test.json");
    expect(signed.oba.kid).toBe(key.kid);
    expect(signed.oba.alg).toBe("EdDSA");
    expect(signed.oba.sig).toBe(sig);

    // Verify the signature locally.
    const payload = preparePayloadForSigning(JSON.parse(fs.readFileSync(manifestPath, "utf-8")));
    const sigBytes = Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/") + "==", "base64");
    const valid = crypto.verify(null, payload, key.publicKeyPem, sigBytes);
    expect(valid).toBe(true);
  });

  it("re-signs a previously signed manifest", () => {
    const manifest = {
      id: "test-plugin",
      oba: { owner: "https://old.com/jwks.json", kid: "old-kid", alg: "EdDSA", sig: "old-sig" },
    };
    const manifestPath = path.join(tmpDir, "openclaw.plugin.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const key = generateObaKeyPair("https://new.com/jwks.json");
    signPluginManifest({ manifestPath, key });

    const signed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(signed.oba.owner).toBe("https://new.com/jwks.json");
    expect(signed.oba.kid).toBe(key.kid);
    expect(signed.oba.sig).not.toBe("old-sig");
  });

  it("throws if no owner is set", () => {
    const manifest = { id: "test-plugin" };
    const manifestPath = path.join(tmpDir, "openclaw.plugin.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const key = generateObaKeyPair(); // no owner
    expect(() => signPluginManifest({ manifestPath, key })).toThrow("No owner URL");
  });

  it("owner override takes precedence", () => {
    const manifest = { id: "test-plugin" };
    const manifestPath = path.join(tmpDir, "openclaw.plugin.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const key = generateObaKeyPair("https://original.com/jwks.json");
    signPluginManifest({ manifestPath, key, ownerOverride: "https://override.com/jwks.json" });

    const signed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(signed.oba.owner).toBe("https://override.com/jwks.json");
  });
});

describe("OBA skill signing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oba-skill-sign-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("signs a SKILL.md and produces valid oba block", () => {
    const skillContent = `---
metadata: {
  openclaw: {
    emoji: "test"
  }
}
---

# Test Skill

This is a test skill.
`;
    const skillPath = path.join(tmpDir, "SKILL.md");
    fs.writeFileSync(skillPath, skillContent);

    const key = generateObaKeyPair("https://example.com/jwks/test.json");
    const { kid, sig } = signSkillMetadata({ skillPath, key });

    expect(kid).toBe(key.kid);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);

    // Read back — should still have frontmatter.
    const content = fs.readFileSync(skillPath, "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("oba");
    expect(content).toContain(key.kid);
  });

  it("throws if no frontmatter found", () => {
    const skillPath = path.join(tmpDir, "SKILL.md");
    fs.writeFileSync(skillPath, "# No Frontmatter\n\nJust content.\n");

    const key = generateObaKeyPair("https://example.com/jwks.json");
    expect(() => signSkillMetadata({ skillPath, key })).toThrow("No frontmatter block");
  });
});

describe("OBA sign + verify round-trip", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oba-roundtrip-"));
    clearJwksCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    clearJwksCache();
  });

  it("signed plugin verifies successfully with mocked JWKS", async () => {
    const manifest = { id: "roundtrip-plugin", version: "1.0.0" };
    const manifestPath = path.join(tmpDir, "openclaw.plugin.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const key = generateObaKeyPair("https://test.openbotauth.org/jwks/test.json");
    signPluginManifest({ manifestPath, key });

    // Build JWK from the public key for mock JWKS response.
    const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
    const pubKeyObj = crypto.createPublicKey(key.publicKeyPem);
    const spki = pubKeyObj.export({ type: "spki", format: "der" }) as Buffer;
    const rawPub = spki.subarray(ED25519_SPKI_PREFIX.length);
    const xValue = base64UrlEncode(rawPub);

    const jwk = { kty: "OKP", crv: "Ed25519", kid: key.kid, x: xValue, use: "sig", alg: "EdDSA" };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const signed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    const result = await verifyObaContainer(signed);
    expect(result.status).toBe("verified");
  });

  it("signed skill verifies successfully with mocked JWKS", async () => {
    const skillContent = `---
metadata: {
  openclaw: {
    emoji: "test"
  }
}
---

# Test Skill

This is a test skill.
`;
    const skillPath = path.join(tmpDir, "SKILL.md");
    fs.writeFileSync(skillPath, skillContent);

    const key = generateObaKeyPair("https://test.openbotauth.org/jwks/test.json");
    signSkillMetadata({ skillPath, key });

    // Build JWK from the public key for mock JWKS response.
    const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
    const pubKeyObj = crypto.createPublicKey(key.publicKeyPem);
    const spki = pubKeyObj.export({ type: "spki", format: "der" }) as Buffer;
    const rawPub = spki.subarray(ED25519_SPKI_PREFIX.length);
    const xValue = base64UrlEncode(rawPub);
    const jwk = { kty: "OKP", crv: "Ed25519", kid: key.kid, x: xValue, use: "sig", alg: "EdDSA" };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    // Parse the signed skill metadata and verify.
    const content = fs.readFileSync(skillPath, "utf-8");
    const parsed = parseSkillMetadataObject(content);
    const result = await verifyObaContainer(parsed);
    expect(result.status).toBe("verified");
  });

  it("tampered manifest fails verification", async () => {
    const manifest = { id: "tamper-test", version: "1.0.0" };
    const manifestPath = path.join(tmpDir, "openclaw.plugin.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const key = generateObaKeyPair("https://test.openbotauth.org/jwks/test.json");
    signPluginManifest({ manifestPath, key });

    // Tamper with the manifest.
    const signed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    signed.id = "tampered-id";
    fs.writeFileSync(manifestPath, JSON.stringify(signed, null, 2));

    // Build mock JWKS.
    const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
    const pubKeyObj = crypto.createPublicKey(key.publicKeyPem);
    const spki = pubKeyObj.export({ type: "spki", format: "der" }) as Buffer;
    const rawPub = spki.subarray(ED25519_SPKI_PREFIX.length);
    const xValue = base64UrlEncode(rawPub);
    const jwk = { kty: "OKP", crv: "Ed25519", kid: key.kid, x: xValue, use: "sig", alg: "EdDSA" };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const tampered = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    const result = await verifyObaContainer(tampered);
    expect(result.status).toBe("invalid");
    expect(result.reason).toBe("signature mismatch");
  });
});

describe("extractSkillMetadata", () => {
  it("extracts metadata from simple frontmatter", () => {
    const content = `---
metadata: { "name": "test" }
---

# Skill
`;
    const { metadataRaw } = extractSkillMetadata(content);
    expect(metadataRaw).toBe('{ "name": "test" }');
  });

  it("extracts multi-line metadata", () => {
    const content = `---
metadata: {
  "name": "test",
  "version": "1.0"
}
---

# Skill
`;
    const { metadataRaw } = extractSkillMetadata(content);
    expect(metadataRaw).toContain('"name": "test"');
    expect(metadataRaw).toContain('"version": "1.0"');
  });

  it("returns correct byte offsets", () => {
    const content = `---
metadata: { "a": 1 }
---
`;
    const { metaStart, metaEnd } = extractSkillMetadata(content);
    // metaStart should point to the "metadata:" key inside the frontmatter.
    expect(content.slice(metaStart, metaEnd)).toContain("metadata:");
    expect(content.slice(metaStart, metaEnd)).toContain('{ "a": 1 }');
  });

  it("throws when no frontmatter block exists", () => {
    expect(() => extractSkillMetadata("# No frontmatter")).toThrow("No frontmatter block");
  });

  it("throws when no metadata field in frontmatter", () => {
    const content = `---
title: Test
---
`;
    expect(() => extractSkillMetadata(content)).toThrow("No metadata field");
  });

  it("stops at the next top-level key", () => {
    const content = `---
metadata: { "a": 1 }
title: Test
---
`;
    const { metadataRaw } = extractSkillMetadata(content);
    expect(metadataRaw).toBe('{ "a": 1 }');
    expect(metadataRaw).not.toContain("title");
  });

  it("does not match substrings like extra_metadata", () => {
    const content = `---
extra_metadata: ignored
metadata: { "real": true }
---
`;
    const { metadataRaw } = extractSkillMetadata(content);
    expect(metadataRaw).toBe('{ "real": true }');
  });

  it("handles CRLF line endings", () => {
    const content = '---\r\nmetadata: { "a": 1 }\r\n---\r\n';
    const { metadataRaw } = extractSkillMetadata(content);
    expect(metadataRaw).toBe('{ "a": 1 }');
  });
});

describe("parseSkillMetadataObject", () => {
  it("returns parsed metadata object", () => {
    const content = `---
metadata: { "name": "test", "version": "1.0" }
---

# Skill
`;
    const result = parseSkillMetadataObject(content);
    expect(result).toEqual({ name: "test", version: "1.0" });
  });

  it("throws on non-object metadata", () => {
    const content = `---
metadata: "just a string"
---
`;
    expect(() => parseSkillMetadataObject(content)).toThrow();
  });

  it("throws on array metadata", () => {
    const content = `---
metadata: [1, 2, 3]
---
`;
    expect(() => parseSkillMetadataObject(content)).toThrow();
  });
});

describe("validateOwnerUrl", () => {
  const origPrivate = process.env.OPENCLAW_OBA_ALLOW_PRIVATE_OWNER;
  const origInsecure = process.env.OPENCLAW_OBA_ALLOW_INSECURE_OWNER;

  afterEach(() => {
    if (origPrivate !== undefined) {
      process.env.OPENCLAW_OBA_ALLOW_PRIVATE_OWNER = origPrivate;
    } else {
      delete process.env.OPENCLAW_OBA_ALLOW_PRIVATE_OWNER;
    }
    if (origInsecure !== undefined) {
      process.env.OPENCLAW_OBA_ALLOW_INSECURE_OWNER = origInsecure;
    } else {
      delete process.env.OPENCLAW_OBA_ALLOW_INSECURE_OWNER;
    }
  });

  it("accepts valid HTTPS URLs", () => {
    const result = validateOwnerUrl("https://example.com/jwks.json");
    expect(result.ok).toBe(true);
  });

  it("rejects non-HTTPS URLs", () => {
    const result = validateOwnerUrl("http://example.com/jwks.json");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("HTTPS");
  });

  it("rejects invalid URLs", () => {
    const result = validateOwnerUrl("not-a-url");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("not a valid URL");
  });

  it("rejects empty string", () => {
    const result = validateOwnerUrl("");
    expect(result.ok).toBe(false);
  });

  it("rejects URLs with credentials", () => {
    const result = validateOwnerUrl("https://user:pass@example.com/jwks.json");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("credentials");
  });

  it("rejects URLs with fragments", () => {
    const result = validateOwnerUrl("https://example.com/jwks.json#section");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("fragment");
  });

  it("rejects private hosts by default", () => {
    delete process.env.OPENCLAW_OBA_ALLOW_PRIVATE_OWNER;
    const result = validateOwnerUrl("https://localhost/jwks.json");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("private");
  });

  it("allows private hosts with OPENCLAW_OBA_ALLOW_PRIVATE_OWNER=1", () => {
    process.env.OPENCLAW_OBA_ALLOW_PRIVATE_OWNER = "1";
    const result = validateOwnerUrl("https://localhost/jwks.json");
    expect(result.ok).toBe(true);
  });

  it("allows private hosts with allowPrivate option", () => {
    delete process.env.OPENCLAW_OBA_ALLOW_PRIVATE_OWNER;
    const result = validateOwnerUrl("https://localhost/jwks.json", { allowPrivate: true });
    expect(result.ok).toBe(true);
  });

  it("allows http://localhost with OPENCLAW_OBA_ALLOW_INSECURE_OWNER=1", () => {
    process.env.OPENCLAW_OBA_ALLOW_INSECURE_OWNER = "1";
    process.env.OPENCLAW_OBA_ALLOW_PRIVATE_OWNER = "1";
    const result = validateOwnerUrl("http://localhost:3000/jwks.json");
    expect(result.ok).toBe(true);
  });

  it("allows http://127.0.0.1 with OPENCLAW_OBA_ALLOW_INSECURE_OWNER=1", () => {
    process.env.OPENCLAW_OBA_ALLOW_INSECURE_OWNER = "1";
    process.env.OPENCLAW_OBA_ALLOW_PRIVATE_OWNER = "1";
    const result = validateOwnerUrl("http://127.0.0.1:3000/jwks.json");
    expect(result.ok).toBe(true);
  });

  it("rejects http://evil.com even with OPENCLAW_OBA_ALLOW_INSECURE_OWNER=1", () => {
    process.env.OPENCLAW_OBA_ALLOW_INSECURE_OWNER = "1";
    const result = validateOwnerUrl("http://evil.com/jwks.json");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("HTTPS");
  });
});

describe("isPrivateHost", () => {
  it("detects localhost", () => {
    expect(isPrivateHost("localhost")).toBe(true);
  });

  it("detects 127.x.x.x", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("127.255.0.1")).toBe(true);
  });

  it("detects 10.x.x.x", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true);
  });

  it("detects 172.16-31.x.x", () => {
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("172.15.0.1")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
  });

  it("detects 192.168.x.x", () => {
    expect(isPrivateHost("192.168.1.1")).toBe(true);
  });

  it("detects link-local 169.254.x.x", () => {
    expect(isPrivateHost("169.254.1.1")).toBe(true);
  });

  it("detects CGNAT 100.64-127.x.x", () => {
    expect(isPrivateHost("100.64.0.1")).toBe(true);
    expect(isPrivateHost("100.127.255.255")).toBe(true);
    expect(isPrivateHost("100.63.0.1")).toBe(false);
    expect(isPrivateHost("100.128.0.1")).toBe(false);
  });

  it("detects IPv6 loopback/unspecified", () => {
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("::")).toBe(true);
    expect(isPrivateHost("::0")).toBe(true);
  });

  it("detects IPv6 link-local (fe80::)", () => {
    expect(isPrivateHost("fe80::1")).toBe(true);
    expect(isPrivateHost("fe80::abcd:1234")).toBe(true);
  });

  it("detects IPv6 unique local (fc00::/fd00::)", () => {
    expect(isPrivateHost("fc00::1")).toBe(true);
    expect(isPrivateHost("fd12:3456::1")).toBe(true);
  });

  it("detects IPv6-mapped IPv4 private addresses", () => {
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateHost("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateHost("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateHost("::ffff:169.254.1.1")).toBe(true);
  });

  it("allows IPv6-mapped IPv4 public addresses", () => {
    expect(isPrivateHost("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateHost("::ffff:1.1.1.1")).toBe(false);
  });

  it("detects .local suffix", () => {
    expect(isPrivateHost("myhost.local")).toBe(true);
  });

  it("detects 0.0.0.0", () => {
    expect(isPrivateHost("0.0.0.0")).toBe(true);
  });

  it("allows public hosts", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("api.openbotauth.org")).toBe(false);
  });

  it("normalizes trailing dot", () => {
    expect(isPrivateHost("localhost.")).toBe(true);
  });
});

describe("Owner validation on signing", () => {
  let tmpDir: string;
  const origPrivate = process.env.OPENCLAW_OBA_ALLOW_PRIVATE_OWNER;
  const origInsecure = process.env.OPENCLAW_OBA_ALLOW_INSECURE_OWNER;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oba-owner-val-"));
    delete process.env.OPENCLAW_OBA_ALLOW_PRIVATE_OWNER;
    delete process.env.OPENCLAW_OBA_ALLOW_INSECURE_OWNER;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origPrivate !== undefined) {
      process.env.OPENCLAW_OBA_ALLOW_PRIVATE_OWNER = origPrivate;
    } else {
      delete process.env.OPENCLAW_OBA_ALLOW_PRIVATE_OWNER;
    }
    if (origInsecure !== undefined) {
      process.env.OPENCLAW_OBA_ALLOW_INSECURE_OWNER = origInsecure;
    } else {
      delete process.env.OPENCLAW_OBA_ALLOW_INSECURE_OWNER;
    }
  });

  it("signing rejects non-HTTPS owner", () => {
    const manifest = { id: "test-plugin" };
    const manifestPath = path.join(tmpDir, "openclaw.plugin.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const key = generateObaKeyPair("http://example.com/jwks.json");
    expect(() => signPluginManifest({ manifestPath, key })).toThrow("Invalid owner URL");
  });

  it("signing rejects private host owner", () => {
    const manifest = { id: "test-plugin" };
    const manifestPath = path.join(tmpDir, "openclaw.plugin.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const key = generateObaKeyPair("https://localhost/jwks.json");
    expect(() => signPluginManifest({ manifestPath, key })).toThrow("Invalid owner URL");
  });

  it("signing allows http://localhost with env overrides", () => {
    process.env.OPENCLAW_OBA_ALLOW_INSECURE_OWNER = "1";
    process.env.OPENCLAW_OBA_ALLOW_PRIVATE_OWNER = "1";

    const manifest = { id: "test-plugin" };
    const manifestPath = path.join(tmpDir, "openclaw.plugin.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const key = generateObaKeyPair("http://localhost:3000/jwks.json");
    const { kid, sig } = signPluginManifest({ manifestPath, key });
    expect(kid).toBe(key.kid);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
