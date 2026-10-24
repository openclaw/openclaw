import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  clearFirstRunActivationReceipt,
  persistFirstRunActivationReceipt,
  readFirstRunActivationReceipt as readReceipt,
} from "./first-run-activation-receipt.ts";

const receiptKey = "openclaw.modelSetup.pendingActivation.v1";
const deviceKey = "openclaw-device-identity-v1";
const privateKey = "high-entropy-device-private-key-never-in-receipts";
const candidate = { kind: "openai-api-key", modelRef: "openai/expected" };
const setDeviceKey = (key: string) =>
  localStorage.setItem(deviceKey, JSON.stringify({ version: 1, privateKey: key }));

function createContext(options: { token?: string; deviceToken?: string } = {}): ApplicationContext {
  return {
    gateway: {
      snapshot: { phase: "connected", hello: { auth: { deviceToken: options.deviceToken } } },
      connection: {
        gatewayUrl: "wss://gateway.example/control?profile=work",
        token: options.token ?? "gateway-auth-token",
        password: "",
        bootstrapToken: "",
      },
    },
    agentSelection: { state: { selectedId: "main" } },
    // SAFETY: receipt ownership consumes only authenticated connection and agent state.
  } as unknown as ApplicationContext;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  setDeviceKey(privateKey);
});

afterEach(() => vi.unstubAllGlobals());

it.each<[string, (context: ApplicationContext) => void]>([
  ["Gateway token", (ctx) => Object.assign(ctx.gateway.connection, { token: "replacement" })],
  ["Gateway URL", (ctx) => Object.assign(ctx.gateway.connection, { gatewayUrl: "wss://other" })],
  ["selected agent", (ctx) => Object.assign(ctx.agentSelection.state, { selectedId: "research" })],
  ["browser device identity", () => setDeviceKey("replacement")],
])("refuses a receipt after its %s changes", (_name, replace) => {
  const context = createContext();
  persistFirstRunActivationReceipt(context, candidate);

  replace(context);

  expect([readReceipt(context), localStorage.getItem(receiptKey)]).toEqual([null, null]);
});

it("binds paired-device authentication when no explicit Gateway credential exists", () => {
  const context = createContext({ token: "", deviceToken: "paired-device-token" });
  persistFirstRunActivationReceipt(context, candidate);

  const persisted = localStorage.getItem(receiptKey) ?? "";
  expect(persisted).not.toContain("paired-device-token");
  expect(persisted).not.toContain(privateKey);
  expect(readReceipt(context)?.modelRef).toBe("openai/expected");
  context.gateway.snapshot.hello!.auth!.deviceToken = "replacement-device-token";

  expect([readReceipt(context), localStorage.getItem(receiptKey)]).toEqual([null, null]);
});

it.each([
  { name: "role", patch: { modelTarget: "utility" } },
  { name: "wizard", patch: { wizard: { sessionId: "replacement", authChoice: "other" } } },
])("rejects a tampered $name without trusting or replaying its owner receipt", ({ patch }) => {
  const context = createContext();
  const receipt = persistFirstRunActivationReceipt(context, {
    kind: "provider-auth",
    modelRef: "openai/expected",
    wizard: { sessionId: "original", authChoice: "custom-api-key", authKind: "secret" },
  });
  localStorage.setItem(receiptKey, JSON.stringify({ ...receipt, ...patch }));

  expect([readReceipt(context), localStorage.getItem(receiptKey)]).toEqual([null, null]);
});

it("fails closed without durable storage, a persisted device key, or authenticated credentials", () => {
  const context = createContext({ token: "" });

  expect(persistFirstRunActivationReceipt(context, candidate)).toBeNull();

  context.gateway.connection.token = "gateway-auth-token";
  localStorage.removeItem(deviceKey);
  expect(persistFirstRunActivationReceipt(context, candidate)).toBeNull();

  const unavailable = () => {
    throw new Error("Browser storage disabled");
  };
  vi.stubGlobal("localStorage", {
    getItem: unavailable,
    setItem: unavailable,
    removeItem: unavailable,
  });
  expect(persistFirstRunActivationReceipt(context, candidate)).toBeNull();
  expect(readReceipt(context)).toBeNull();
  expect(() => clearFirstRunActivationReceipt()).not.toThrow();
});
