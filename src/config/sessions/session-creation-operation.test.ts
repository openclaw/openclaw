import { describe, expect, it } from "vitest";
import {
  CREATION_OPERATION_VALIDITY_MS,
  CREATION_OPERATION_FUTURE_SKEW_MS,
  prepareSessionCreationOperation,
  assertSessionCreationOperationTime,
} from "./session-creation-operation.js";

const now = 1_800_000_000_000;
function uuidAt(time: number) {
  const hex = time.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7c62-bef8-f26bc2e8c724`;
}
const sessionId = uuidAt(now);
const nonce = "0123456789abcdef0123456789abcdef";
const operationId = (issuedAt = now) => `v1:${issuedAt}:${nonce}`;
const prepare = (id = operationId(), principal = "verified-profile", params = { label: "work" }) =>
  prepareSessionCreationOperation(
    principal,
    id,
    uuidAt(Number(id.split(":")[1]) || now),
    params,
    now,
  );

describe("native creation operation identity", () => {
  it("binds the full immutable identity and verified caller, separately from arguments", () => {
    const original = prepare();
    expect(prepare()).toEqual(original);
    expect(prepare(operationId(now - 1)).digest).not.toBe(original.digest);
    expect(prepare(operationId(), "other-profile").digest).not.toBe(original.digest);
    const changed = prepare(operationId(), "verified-profile", { label: "other" });
    expect(changed.digest).toBe(original.digest);
    expect(changed.requestFingerprint).not.toBe(original.requestFingerprint);
  });
  it("accepts both canonical identity syntaxes with stable domain-separated digests", () => {
    const legacy = prepare();
    const hyphenId = `v1-${now}-${nonce}`;
    const hyphen = prepareSessionCreationOperation(
      "verified-profile",
      hyphenId,
      sessionId,
      { label: "work" },
      now,
    );
    expect(legacy.digest).toBe("84a2363a15b01c36c6fa05076e7aa98f000bc920b308fb060659b85e1e4dcb65");
    expect(hyphen.digest).toBe("a741afd3f41ebba74a4ea5f58b2237eecdf39596e43166ee0e01a628b9204de4");
    expect(hyphen).toMatchObject({
      issuedAt: now,
      expiresAt: now + CREATION_OPERATION_VALIDITY_MS,
      sessionId,
    });
    expect(hyphen.requestFingerprint).toBe(legacy.requestFingerprint);
    expect(() => assertSessionCreationOperationTime(hyphen, hyphen.expiresAt)).toThrow(/expired/);
    expect(() =>
      prepareSessionCreationOperation("verified-profile", hyphenId, uuidAt(now - 1), {}, now),
    ).toThrow(/UUIDv7/);
  });
  it.each([`v1:${now}-${nonce}`, `v1-${now}:${nonce}`, `v1-0${now}-${nonce}`, `v1-${now}-bad`])(
    "rejects a mixed or noncanonical operation identity %s",
    (id) => {
      expect(() =>
        prepareSessionCreationOperation("verified-profile", id, sessionId, {}, now),
      ).toThrow(/canonical operation identity/);
    },
  );
  it.each([
    "v1:01800000000000:" + nonce,
    "v2:" + now + ":" + nonce,
    "v1:" + now + ":bad",
    "v1:9007199254740991:" + nonce,
  ])("rejects malformed or overflowing identity %s", (id) => {
    expect(() => prepare(id)).toThrow();
  });
  it("admits only bounded future skew", () => {
    expect(() => prepare(operationId(now + CREATION_OPERATION_FUTURE_SKEW_MS))).not.toThrow();
    expect(() => prepare(operationId(now + CREATION_OPERATION_FUTURE_SKEW_MS + 1))).toThrow();
  });
  it("rejects the unchanged identity at expiry, independently of receipt presence", () => {
    const original = prepare();
    expect(() =>
      assertSessionCreationOperationTime(original, now + CREATION_OPERATION_VALIDITY_MS - 1),
    ).not.toThrow();
    expect(() =>
      assertSessionCreationOperationTime(original, now + CREATION_OPERATION_VALIDITY_MS),
    ).toThrow(/expired/);
    expect(() =>
      assertSessionCreationOperationTime({ ...original, expiresAt: original.expiresAt + 1 }, now),
    ).toThrow();
  });
  it("cannot bind a fresh operation to an expired physical UUID", () => {
    const later = now + CREATION_OPERATION_VALIDITY_MS;
    expect(() =>
      prepareSessionCreationOperation("profile", operationId(later), sessionId, {}, later),
    ).toThrow(/UUIDv7/);
    expect(() =>
      prepareSessionCreationOperation("profile", operationId(later), uuidAt(later), {}, later),
    ).not.toThrow();
  });
  it("requires a verified caller and canonical physical UUID", () => {
    expect(() => prepare(operationId(), "")).toThrow();
    expect(() =>
      prepareSessionCreationOperation("profile", operationId(), "not-a-uuid", {}, now),
    ).toThrow();
  });
});
