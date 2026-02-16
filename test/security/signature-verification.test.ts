import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PluginSigner } from "../../src/plugins/plugin-signing.js";

describe("Plugin Signature Verification", () => {
  let tempDir: string;
  let privateKey: string;
  let publicKey: string;
  let untrustedPrivateKey: string;
  let untrustedPublicKey: string;

  beforeEach(() => {
    // Create temporary directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-sig-test-"));

    // Generate test key pair
    const { privateKey: privKey, publicKey: pubKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: "spki",
        format: "pem",
      },
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem",
      },
    });

    privateKey = privKey;
    publicKey = pubKey;

    // Generate untrusted key pair
    const { privateKey: untrustedPrivKey, publicKey: untrustedPubKey } = crypto.generateKeyPairSync(
      "rsa",
      {
        modulusLength: 2048,
        publicKeyEncoding: {
          type: "spki",
          format: "pem",
        },
        privateKeyEncoding: {
          type: "pkcs8",
          format: "pem",
        },
      },
    );

    untrustedPrivateKey = untrustedPrivKey;
    untrustedPublicKey = untrustedPubKey;
  });

  afterEach(() => {
    // Cleanup temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Plugin Signing", () => {
    it("should sign a plugin successfully", () => {
      const pluginPath = path.join(tempDir, "test-plugin.ts");
      const pluginCode = "export default { register: () => {} };";
      fs.writeFileSync(pluginPath, pluginCode);

      const signature = PluginSigner.signPlugin(pluginPath, privateKey, "1.0.0");

      expect(signature).toBeDefined();
      expect(signature.algorithm).toBe("RSA-SHA256");
      expect(signature.signature).toBeTruthy();
      expect(signature.publicKey).toBeTruthy();
      expect(signature.version).toBe("1.0.0");
      expect(signature.timestamp).toBeGreaterThan(0);
    });

    it("should throw error when plugin file does not exist", () => {
      const nonExistentPath = path.join(tempDir, "nonexistent.ts");

      expect(() => {
        PluginSigner.signPlugin(nonExistentPath, privateKey, "1.0.0");
      }).toThrow("Plugin file not found");
    });

    it("should throw error with invalid private key", () => {
      const pluginPath = path.join(tempDir, "test-plugin.ts");
      fs.writeFileSync(pluginPath, "export default { register: () => {} };");

      expect(() => {
        PluginSigner.signPlugin(pluginPath, "invalid-key", "1.0.0");
      }).toThrow();
    });
  });

  describe("Signature Verification", () => {
    it("should verify valid signature", () => {
      const pluginPath = path.join(tempDir, "test-plugin.ts");
      const pluginCode = "export default { register: () => {} };";
      fs.writeFileSync(pluginPath, pluginCode);

      const signature = PluginSigner.signPlugin(pluginPath, privateKey, "1.0.0");
      const isValid = PluginSigner.verifySignature(pluginPath, signature, [publicKey]);

      expect(isValid).toBe(true);
    });

    it("should reject unsigned plugin", () => {
      const pluginPath = path.join(tempDir, "unsigned-plugin.ts");
      fs.writeFileSync(pluginPath, "export default { register: () => {} };");

      const result = PluginSigner.verifyPluginDirectory(tempDir, "unsigned-plugin.ts", [publicKey]);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("No signature found");
    });

    it("should reject tampered plugin", () => {
      const pluginPath = path.join(tempDir, "test-plugin.ts");
      const originalCode = "export default { register: () => {} };";
      fs.writeFileSync(pluginPath, originalCode);

      const signature = PluginSigner.signPlugin(pluginPath, privateKey, "1.0.0");

      // Tamper with plugin after signing
      const tamperedCode = originalCode + "\n// malicious code";
      fs.writeFileSync(pluginPath, tamperedCode);

      expect(() => {
        PluginSigner.verifySignature(pluginPath, signature, [publicKey]);
      }).toThrow("Invalid signature");
    });

    it("should reject untrusted public key", () => {
      const pluginPath = path.join(tempDir, "test-plugin.ts");
      fs.writeFileSync(pluginPath, "export default { register: () => {} };");

      // Sign with untrusted key
      const signature = PluginSigner.signPlugin(pluginPath, untrustedPrivateKey, "1.0.0");

      // Try to verify with only trusted keys (not including untrusted)
      expect(() => {
        PluginSigner.verifySignature(pluginPath, signature, [publicKey]);
      }).toThrow("Untrusted public key");
    });

    it("should accept plugin signed by any trusted key", () => {
      const pluginPath = path.join(tempDir, "test-plugin.ts");
      fs.writeFileSync(pluginPath, "export default { register: () => {} };");

      const signature = PluginSigner.signPlugin(pluginPath, privateKey, "1.0.0");

      // Verify with multiple trusted keys
      const isValid = PluginSigner.verifySignature(pluginPath, signature, [
        untrustedPublicKey,
        publicKey,
      ]);

      expect(isValid).toBe(true);
    });

    it("should reject plugin when no trusted keys provided", () => {
      const pluginPath = path.join(tempDir, "test-plugin.ts");
      fs.writeFileSync(pluginPath, "export default { register: () => {} };");

      const signature = PluginSigner.signPlugin(pluginPath, privateKey, "1.0.0");

      expect(() => {
        PluginSigner.verifySignature(pluginPath, signature, []);
      }).toThrow("Untrusted public key");
    });
  });

  describe("Plugin Directory Verification", () => {
    it("should verify plugin directory with valid signature", () => {
      const pluginPath = path.join(tempDir, "index.ts");
      fs.writeFileSync(pluginPath, "export default { register: () => {} };");

      const signature = PluginSigner.signPlugin(pluginPath, privateKey, "1.0.0");
      const signaturePath = path.join(tempDir, "plugin.signature.json");
      fs.writeFileSync(signaturePath, JSON.stringify(signature));

      const result = PluginSigner.verifyPluginDirectory(tempDir, "index.ts", [publicKey]);

      expect(result.valid).toBe(true);
      expect(result.signature).toBeDefined();
      expect(result.signature?.version).toBe("1.0.0");
    });

    it("should fail when signature file is missing", () => {
      const pluginPath = path.join(tempDir, "index.ts");
      fs.writeFileSync(pluginPath, "export default { register: () => {} };");

      const result = PluginSigner.verifyPluginDirectory(tempDir, "index.ts", [publicKey]);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("No signature found");
    });

    it("should fail when signature file is corrupted", () => {
      const pluginPath = path.join(tempDir, "index.ts");
      fs.writeFileSync(pluginPath, "export default { register: () => {} };");

      // Create corrupted signature file
      const signaturePath = path.join(tempDir, "plugin.signature.json");
      fs.writeFileSync(signaturePath, "{ invalid json");

      const result = PluginSigner.verifyPluginDirectory(tempDir, "index.ts", [publicKey]);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unexpected");
    });
  });

  describe("Integrity Checks", () => {
    it("should detect plugin tampering", () => {
      const pluginPath = path.join(tempDir, "index.ts");
      const originalCode = "export default { register: () => {} };";
      fs.writeFileSync(pluginPath, originalCode);

      const signature = PluginSigner.signPlugin(pluginPath, privateKey, "1.0.0");
      const signaturePath = path.join(tempDir, "plugin.signature.json");
      fs.writeFileSync(signaturePath, JSON.stringify(signature));

      // Verify integrity before tampering
      expect(PluginSigner.checkIntegrity(pluginPath, signaturePath)).toBe(true);

      // Tamper with plugin
      fs.appendFileSync(pluginPath, "\n// malicious code");

      // Verify integrity fails after tampering
      expect(PluginSigner.checkIntegrity(pluginPath, signaturePath)).toBe(false);
    });

    it("should return false for missing files", () => {
      const pluginPath = path.join(tempDir, "nonexistent.ts");
      const signaturePath = path.join(tempDir, "plugin.signature.json");

      expect(PluginSigner.checkIntegrity(pluginPath, signaturePath)).toBe(false);
    });
  });

  describe("Signature Metadata", () => {
    it("should retrieve signature metadata without verification", () => {
      const pluginPath = path.join(tempDir, "index.ts");
      fs.writeFileSync(pluginPath, "export default { register: () => {} };");

      const signature = PluginSigner.signPlugin(pluginPath, privateKey, "1.0.0");
      const signaturePath = path.join(tempDir, "plugin.signature.json");
      fs.writeFileSync(signaturePath, JSON.stringify(signature));

      const metadata = PluginSigner.getSignatureMetadata(tempDir);

      expect(metadata).toBeDefined();
      expect(metadata?.version).toBe("1.0.0");
      expect(metadata?.algorithm).toBe("RSA-SHA256");
    });

    it("should return null when signature file is missing", () => {
      const metadata = PluginSigner.getSignatureMetadata(tempDir);
      expect(metadata).toBeNull();
    });

    it("should return null when signature file is corrupted", () => {
      const signaturePath = path.join(tempDir, "plugin.signature.json");
      fs.writeFileSync(signaturePath, "invalid json");

      const metadata = PluginSigner.getSignatureMetadata(tempDir);
      expect(metadata).toBeNull();
    });
  });

  describe("Production Mode Behavior", () => {
    it("should enforce signature verification in production", () => {
      // This test would be integrated with the loader tests
      // Here we just verify the signing mechanics work
      const pluginPath = path.join(tempDir, "index.ts");
      fs.writeFileSync(pluginPath, "export default { register: () => {} };");

      const signature = PluginSigner.signPlugin(pluginPath, privateKey, "1.0.0");
      const signaturePath = path.join(tempDir, "plugin.signature.json");
      fs.writeFileSync(signaturePath, JSON.stringify(signature));

      const result = PluginSigner.verifyPluginDirectory(tempDir, "index.ts", [publicKey]);

      expect(result.valid).toBe(true);
    });
  });

  describe("Multiple Versions", () => {
    it("should sign and verify different versions separately", () => {
      const pluginPath = path.join(tempDir, "index.ts");
      fs.writeFileSync(pluginPath, "export default { register: () => {} };");

      const sig1 = PluginSigner.signPlugin(pluginPath, privateKey, "1.0.0");
      const sig2 = PluginSigner.signPlugin(pluginPath, privateKey, "2.0.0");

      expect(sig1.version).toBe("1.0.0");
      expect(sig2.version).toBe("2.0.0");
      expect(sig1.signature).not.toBe(sig2.signature); // Different versions = different signatures

      // Both should verify
      expect(PluginSigner.verifySignature(pluginPath, sig1, [publicKey])).toBe(true);
      expect(PluginSigner.verifySignature(pluginPath, sig2, [publicKey])).toBe(true);
    });
  });
});
