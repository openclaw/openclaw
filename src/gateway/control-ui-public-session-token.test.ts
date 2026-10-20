import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDeviceIdentityIfPresentAsync } from "../infra/device-identity-async.js";
import { deriveCanonicalEd25519PrivateKeyRaw } from "../infra/ed25519-signature.js";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadPublicSessionShareTokenCodec,
  mintExistingPublicSessionShareToken,
  mintPublicSessionWidgetToken,
  resolvePublicSessionShareToken,
  resolvePublicSessionWidgetToken,
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
  it("round-trips an exact locator without exposing any identifier", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const codec = await loadPublicSessionShareTokenCodec();
      expect(loadPublicSessionShareTokenCodec()).toBe(codec);
      const token = codec.mint(LOCATOR);
      expect(codec.resolve(token)).toEqual(LOCATOR);
      for (const identifier of Object.values(LOCATOR)) {
        expect(token).not.toContain(identifier);
      }
      expect(isSecretValueRegisteredForRedaction(token)).toBe(true);
      expect(isSecretValueRegisteredForRedaction(LOCATOR.shareId)).toBe(true);
      expect(prepare).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    });
  });

  it("uses fresh nonces while retaining the same restart-stable identity", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const first = await loadPublicSessionShareTokenCodec();
      const firstToken = first.mint(LOCATOR);
      const secondToken = first.mint(LOCATOR);
      const second = await loadPublicSessionShareTokenCodec();
      expect(secondToken).not.toBe(firstToken);
      expect(second.resolve(firstToken)).toEqual(LOCATOR);
      expect(second.resolve(secondToken)).toEqual(LOCATOR);
    });
  });

  it("fails closed for tampering, another installation, and malformed tokens", async () => {
    const token = await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const codec = await loadPublicSessionShareTokenCodec();
      const created = codec.mint(LOCATOR);
      const last = created.at(-1) ?? "";
      const tampered = `${created.slice(0, -1)}${last === "a" ? "b" : "a"}`;
      expect(codec.resolve(tampered)).toBeNull();
      expect(codec.resolve("v1.invalid+base64")).toBeNull();
      expect(codec.resolve(`v2.${created.slice(3)}`)).toBeNull();
      return created;
    });
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      expect(await resolvePublicSessionShareToken(token)).toBeNull();
    });
  });

  it("does not create durable identity state from an anonymous token", async () => {
    const foreignToken = await withOpenClawTestState({ scenario: "minimal" }, async () =>
      (await loadPublicSessionShareTokenCodec()).mint(LOCATOR),
    );
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      expect(await resolvePublicSessionShareToken(foreignToken)).toBeNull();
      expect(await mintExistingPublicSessionShareToken(LOCATOR)).toBeUndefined();
      expect(await mintPublicSessionWidgetToken(LOCATOR, "widget-a")).toBeUndefined();
      expect(await resolvePublicSessionWidgetToken(foreignToken)).toBeNull();
      expect(await loadDeviceIdentityIfPresentAsync()).toBeNull();

      const localToken = (await loadPublicSessionShareTokenCodec()).mint(LOCATOR);
      expect(await loadDeviceIdentityIfPresentAsync()).not.toBeNull();
      expect(await resolvePublicSessionShareToken(localToken)).toEqual(LOCATOR);
      const preview = await mintExistingPublicSessionShareToken(LOCATOR);
      expect(await mintExistingPublicSessionShareToken(LOCATOR)).toBe(preview);
      expect(await resolvePublicSessionShareToken(preview!)).toEqual(LOCATOR);
    });
  });
});

describe("public session widget token", () => {
  it("binds one document, separates publication authority, and remains stable across renders", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const codec = await loadPublicSessionShareTokenCodec();
      const shareToken = codec.mint(LOCATOR);
      const token = await mintPublicSessionWidgetToken(LOCATOR, "widget-a");
      expect(token).toBeDefined();
      expect(await resolvePublicSessionWidgetToken(token!)).toEqual({
        locator: LOCATOR,
        docId: "widget-a",
      });
      expect(await resolvePublicSessionWidgetToken(shareToken)).toBeNull();
      expect(await resolvePublicSessionShareToken(token!)).toBeNull();
      const other = await mintPublicSessionWidgetToken(LOCATOR, "widget-b");
      expect(other).not.toBe(token);
      expect(await resolvePublicSessionWidgetToken(other!)).toEqual({
        locator: LOCATOR,
        docId: "widget-b",
      });
      expect(
        await mintPublicSessionWidgetToken(
          {
            shareId: LOCATOR.shareId,
            sessionId: LOCATOR.sessionId,
            sessionKey: LOCATOR.sessionKey,
            agentId: LOCATOR.agentId,
          },
          "widget-a",
        ),
      ).toBe(token);
      const otherLocator = { ...LOCATOR, sessionId: "other-session" };
      const otherSession = await mintPublicSessionWidgetToken(otherLocator, "widget-a");
      expect(otherSession).not.toBe(token);
      expect(await resolvePublicSessionWidgetToken(otherSession!)).toEqual({
        locator: otherLocator,
        docId: "widget-a",
      });
      expect(await mintPublicSessionWidgetToken(LOCATOR, "widget-a")).toBe(token);
      expect(isSecretValueRegisteredForRedaction(token!)).toBe(true);
      resetSecretRedactionRegistryForTest();
      await resolvePublicSessionWidgetToken(token!);
      expect(isSecretValueRegisteredForRedaction(token!)).toBe(true);
      expect(isSecretValueRegisteredForRedaction(LOCATOR.shareId)).toBe(true);
      const last = token!.at(-1);
      expect(
        await resolvePublicSessionWidgetToken(`${token!.slice(0, -1)}${last === "a" ? "b" : "a"}`),
      ).toBeNull();
      expect(await resolvePublicSessionWidgetToken(`v1.${"a".repeat(16_384)}`)).toBeNull();
      for (const docId of ["", ".", "..", "../widget", " widget", "widget/a", "a".repeat(129)]) {
        await expect(mintPublicSessionWidgetToken(LOCATOR, docId)).rejects.toThrow(
          "invalid public session widget document",
        );
      }
    });
  });

  it("rejects authenticated claims with invalid documents or unexpected fields", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await loadPublicSessionShareTokenCodec();
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
      expect(await resolvePublicSessionShareToken(seal({ v: 1, ...LOCATOR }))).toBeNull();
      expect(
        await resolvePublicSessionWidgetToken(
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
        expect(
          await resolvePublicSessionWidgetToken(seal({ v: 1, ...LOCATOR, ...extra })),
        ).toBeNull();
      }
      const docId = "a".repeat(128);
      expect(await resolvePublicSessionWidgetToken(seal({ v: 1, ...LOCATOR, doc: docId }))).toEqual(
        {
          locator: LOCATOR,
          docId,
        },
      );
      key.fill(0);
    });
  });
});
