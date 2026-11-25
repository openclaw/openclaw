import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDeviceIdentityIfPresentAsync } from "../infra/device-identity-async.js";
import { deriveCanonicalEd25519PrivateKeyRaw } from "../infra/ed25519-signature.js";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadPublicSessionShareTokenCodec as loadCodec,
  mintExistingPublicSessionShareToken as mintPreview,
  mintPublicSessionWidgetToken as mintWidget,
  resolvePublicSessionShareToken as resolveShare,
  resolvePublicSessionWidgetToken as resolveWidget,
  type PublicSessionShareLocator,
} from "./control-ui-public-session-token.js";

const LOCATOR: PublicSessionShareLocator = {
  agentId: "opaque-agent-identifier",
  sessionKey: "agent:opaque-agent-identifier:discord:channel:private-team-identifier",
  sessionId: "opaque-séssion-identifier.123",
  shareId: "a".repeat(48),
};

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
});

describe("public session share token", () => {
  it("round-trips opaque locators with fresh nonces and a stable cached identity", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const codec = await loadCodec();
      expect(loadCodec()).toBe(codec);
      const token = codec.mint(LOCATOR);
      expect(codec.resolve(token)).toEqual(LOCATOR);
      const secondToken = codec.mint(LOCATOR);
      expect(secondToken).not.toBe(token);
      expect(codec.resolve(secondToken)).toEqual(LOCATOR);
      for (const identifier of Object.values(LOCATOR)) {
        expect(token).not.toContain(identifier);
      }
      expect(isSecretValueRegisteredForRedaction(token)).toBe(true);
      expect(isSecretValueRegisteredForRedaction(LOCATOR.shareId)).toBe(true);
      expect(prepare).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    });
  });

  it("fails closed for tampering, another installation, and malformed tokens", async () => {
    const token = await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const codec = await loadCodec();
      const created = codec.mint(LOCATOR);
      const last = created.at(-1) ?? "";
      const tampered = `${created.slice(0, -1)}${last === "a" ? "b" : "a"}`;
      expect(codec.resolve(tampered)).toBeNull();
      expect(codec.resolve("v1.invalid+base64")).toBeNull();
      expect(codec.resolve(`v2.${created.slice(3)}`)).toBeNull();
      return created;
    });
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      expect(await resolveShare(token)).toBeNull();
    });
  });

  it("does not create durable identity state from an anonymous token", async () => {
    const foreignToken = await withOpenClawTestState({ scenario: "minimal" }, async () =>
      (await loadCodec()).mint(LOCATOR),
    );
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      expect(await resolveShare(foreignToken)).toBeNull();
      expect(await mintPreview(LOCATOR)).toBeUndefined();
      expect(await mintWidget(LOCATOR, "widget-a")).toBeUndefined();
      expect(await resolveWidget(foreignToken)).toBeNull();
      expect(await loadDeviceIdentityIfPresentAsync()).toBeNull();

      const localToken = (await loadCodec()).mint(LOCATOR);
      expect(await loadDeviceIdentityIfPresentAsync()).not.toBeNull();
      expect(await resolveShare(localToken)).toEqual(LOCATOR);
      const preview = await mintPreview(LOCATOR);
      expect(await mintPreview(LOCATOR)).toBe(preview);
      expect(await resolveShare(preview!)).toEqual(LOCATOR);
    });
  });
});

describe("public session widget token", () => {
  it("binds one document, separates publication authority, and remains stable across renders", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const codec = await loadCodec();
      const shareToken = codec.mint(LOCATOR);
      const token = await mintWidget(LOCATOR, "widget-a");
      expect(token).toBeDefined();
      expect(await resolveWidget(token!)).toEqual({ locator: LOCATOR, docId: "widget-a" });
      expect(await resolveWidget(shareToken)).toBeNull();
      expect(await resolveShare(token!)).toBeNull();
      const other = await mintWidget(LOCATOR, "widget-b");
      expect(other).not.toBe(token);
      expect(await resolveWidget(other!)).toEqual({ locator: LOCATOR, docId: "widget-b" });
      const { agentId, ...otherFields } = LOCATOR;
      expect(await mintWidget({ ...otherFields, agentId }, "widget-a")).toBe(token);
      const otherLocator = { ...LOCATOR, sessionId: "other-session" };
      const otherSession = await mintWidget(otherLocator, "widget-a");
      expect(otherSession).not.toBe(token);
      expect(await resolveWidget(otherSession!)).toEqual({
        locator: otherLocator,
        docId: "widget-a",
      });
      expect(await mintWidget(LOCATOR, "widget-a")).toBe(token);
      expect(isSecretValueRegisteredForRedaction(token!)).toBe(true);
      resetSecretRedactionRegistryForTest();
      await resolveWidget(token!);
      expect(isSecretValueRegisteredForRedaction(token!)).toBe(true);
      expect(isSecretValueRegisteredForRedaction(LOCATOR.shareId)).toBe(true);
      const last = token!.at(-1);
      expect(await resolveWidget(`${token!.slice(0, -1)}${last === "a" ? "b" : "a"}`)).toBeNull();
      expect(await resolveWidget(`v1.${"a".repeat(16_384)}`)).toBeNull();
      for (const docId of ["", ".", "..", "../widget", " widget", "widget/a", "a".repeat(129)]) {
        expect(await mintWidget(LOCATOR, docId)).toBeUndefined();
      }
    });
  });

  it("rejects authenticated claims with invalid documents or unexpected fields", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await loadCodec();
      const identity = await loadDeviceIdentityIfPresentAsync();
      const seed = deriveCanonicalEd25519PrivateKeyRaw(identity!.privateKeyPem);
      const key = Buffer.from(
        hkdfSync(
          "sha256",
          seed,
          "openclaw.public-session-share-locator.salt.v1",
          "openclaw.public-session-share-locator.key.v1",
          32,
        ),
      );
      seed.fill(0);
      const seal = (claims: object, aad = "openclaw.public-session-widget-locator.aad.v1") => {
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(Buffer.from(aad));
        const ciphertext = Buffer.concat([
          cipher.update(JSON.stringify(claims), "utf8"),
          cipher.final(),
        ]);
        return `v1.${Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
      };
      expect(await resolveShare(seal({ v: 1, ...LOCATOR }))).toBeNull();
      expect(
        await resolveWidget(
          seal({ v: 1, ...LOCATOR, doc: "widget" }, "openclaw.public-session-share-locator.aad.v1"),
        ),
      ).toBeNull();
      for (const extra of [
        {},
        { doc: "" },
        { doc: "." },
        { doc: ".." },
        { doc: "widget/path" },
        { doc: "a".repeat(129) },
        { doc: 1 },
        { doc: "widget", extra: "unexpected" },
        { doc: "widget", v: 2 },
      ]) {
        expect(await resolveWidget(seal({ v: 1, ...LOCATOR, ...extra }))).toBeNull();
      }
      const docId = "a".repeat(128);
      expect(await resolveWidget(seal({ v: 1, ...LOCATOR, doc: docId }))).toEqual({
        locator: LOCATOR,
        docId,
      });
      key.fill(0);
    });
  });
});
