import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";
import { HelloOkSchema } from "./schema/frames.js";

describe("gateway protocol hello-ok schema", () => {
  const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateHelloOk = ajv.compile(HelloOkSchema);

  const baseHelloOk = {
    type: "hello-ok",
    protocol: 3,
    server: {
      version: "dev",
      connId: "ws-1",
    },
    features: {
      methods: ["health"],
      events: ["tick"],
    },
    snapshot: {
      presence: [],
      health: {},
      stateVersion: {
        presence: 0,
        health: 0,
      },
      uptimeMs: 0,
    },
    auth: {
      role: "operator",
      scopes: ["operator.read"],
    },
    policy: {
      maxPayload: 1024,
      maxBufferedBytes: 2048,
      tickIntervalMs: 15000,
    },
  };

  it("accepts hello-ok payloads with negotiated auth", () => {
    expect(validateHelloOk(baseHelloOk)).toBe(true);
  });

  it("rejects hello-ok payloads without auth", () => {
    const { auth: _auth, ...payloadWithoutAuth } = baseHelloOk;
    expect(validateHelloOk(payloadWithoutAuth)).toBe(false);
  });
});
