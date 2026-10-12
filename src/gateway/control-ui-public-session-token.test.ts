import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDeviceIdentityIfPresentAsync } from "../infra/device-identity-async.js";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadPublicSessionShareTokenCodec,
  mintExistingPublicSessionShareToken,
  resolvePublicSessionShareToken,
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
      expect(await mintExistingPublicSessionShareToken(LOCATOR)).toBeNull();
      expect(await loadDeviceIdentityIfPresentAsync()).toBeNull();

      const localToken = (await loadPublicSessionShareTokenCodec()).mint(LOCATOR);
      expect(await loadDeviceIdentityIfPresentAsync()).not.toBeNull();
      expect(await resolvePublicSessionShareToken(localToken)).toEqual(LOCATOR);
      const canonicalToken = await mintExistingPublicSessionShareToken(LOCATOR);
      expect(canonicalToken).not.toBeNull();
      expect(await mintExistingPublicSessionShareToken(LOCATOR)).toBe(canonicalToken);
      expect(await resolvePublicSessionShareToken(canonicalToken!)).toEqual(LOCATOR);
    });
  });
});
