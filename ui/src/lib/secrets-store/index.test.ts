import { describe, expect, it } from "vitest";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import {
  bulkSetSecretsStoreEntries,
  createInitialSecretsStoreState,
  deleteSecretsStoreEntry,
  parseSecretsStoreBulkInput,
  setSecretsStoreEntry,
} from "./index.ts";

function storeWithSnapshots(...snapshots: unknown[][]) {
  const responses = snapshots.flatMap((entries) => [{ ok: true, reloaded: false }, { entries }]);
  const request = createGatewayRequestMock(async () => responses.shift());
  const client = createTestGatewayClient(request);
  return { state: createInitialSecretsStoreState({ client, connected: true }), request };
}

describe("secrets store state", () => {
  it.each(["set", "delete"] as const)(
    "retains an acknowledged %s after a failed list refresh",
    async (operation) => {
      const { state, request } = storeWithSnapshots([]);
      const receipt = { ok: true, reloaded: true, warningCount: 2 };
      state.loaded = true;
      request
        .mockResolvedValueOnce(receipt)
        .mockRejectedValueOnce(new Error("Inventory unavailable"));
      const result =
        operation === "set"
          ? await setSecretsStoreEntry(state, {
              name: "SERVICE_URL",
              value: "synthetic",
              kind: "env",
              allowedHosts: "",
            })
          : await deleteSecretsStoreEntry(state, "SERVICE_URL");
      expect(result).toEqual(receipt);
      expect(state.error).toBe("Inventory unavailable");
      expect(state.loaded).toBe(false);
      expect(state.busy).toBe(false);
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "secrets.store." + operation,
        "secrets.store.list",
      ]);
    },
  );

  it.each(["set", "delete"] as const)(
    "does not turn a rejected %s into success after a list refresh",
    async (operation) => {
      const { state, request } = storeWithSnapshots([]);
      request
        .mockRejectedValueOnce(new Error("Mutation refused"))
        .mockResolvedValueOnce({ entries: [] });
      const result =
        operation === "set"
          ? await setSecretsStoreEntry(state, {
              name: "SERVICE_URL",
              value: "synthetic",
              kind: "env",
              allowedHosts: "",
            })
          : await deleteSecretsStoreEntry(state, "SERVICE_URL");
      expect(result).toBeNull();
      expect(state.error).toBe("Mutation refused");
      expect(state.busy).toBe(false);
    },
  );

  it.each([false, true])(
    "returns a bulk receipt only when every write was acknowledged (complete: %s)",
    async (complete) => {
      const { state, request } = storeWithSnapshots([]);
      request
        .mockResolvedValueOnce({ ok: true, reloaded: true, warningCount: 2 })
        .mockResolvedValueOnce({ entries: [] });
      if (complete) {
        request
          .mockResolvedValueOnce({ ok: true, reloaded: false, warningCount: 1 })
          .mockRejectedValueOnce(new Error("Inventory unavailable"))
          .mockRejectedValueOnce(new Error("Inventory still unavailable"));
      } else {
        request
          .mockRejectedValueOnce(new Error("Second write refused"))
          .mockResolvedValueOnce({ entries: [] });
      }
      const result = await bulkSetSecretsStoreEntries(state, [
        { name: "ONE", value: "one", kind: "env" },
        { name: "TWO", value: "two", kind: "env" },
      ]);
      expect(result).toEqual(complete ? { saved: 2, warningCount: 2 } : null);
      expect(state.loaded).toBe(!complete);
      expect(state.error).toBe(
        complete
          ? "Inventory unavailable"
          : "Saved 1 of 2 entries. Couldn’t finish the import. Reload the list to check what was saved.\nSecond write refused",
      );
      expect(state.busy).toBe(false);
      expect(request.mock.calls.filter(([method]) => method === "secrets.store.set")).toHaveLength(
        2,
      );
    },
  );

  it("separates the saved count from the failure detail after a partial bulk save", async () => {
    const { state, request } = storeWithSnapshots([]);
    request
      .mockResolvedValueOnce({ ok: true, reloaded: false })
      .mockRejectedValueOnce(new Error("Store unavailable"))
      .mockResolvedValueOnce({ entries: [] });
    expect(
      await bulkSetSecretsStoreEntries(state, [
        { name: "FIRST", value: "one", kind: "env" },
        { name: "SECOND", value: "two", kind: "env" },
      ]),
    ).toBeNull();
    expect(state.error).toBe(
      "Saved 1 of 2 entries. Couldn’t finish the import. Reload the list to check what was saved.\nStore unavailable",
    );
    expect(state.busy).toBe(false);
  });

  it("parses quoted multiline dotenv values and classifies sensitive names", () => {
    const parsed = parseSecretsStoreBulkInput(
      'SERVICE_URL="https://service.test?a=b"\nSERVICE_API_KEY="line one\nline two"\nPLAIN=value',
      true,
    );
    expect(parsed).toEqual({
      entries: [
        { name: "SERVICE_URL", value: "https://service.test?a=b", kind: "env" },
        { name: "SERVICE_API_KEY", value: "line one\nline two", kind: "secret" },
        { name: "PLAIN", value: "value", kind: "env" },
      ],
      invalidNames: [],
    });
    expect(parseSecretsStoreBulkInput("SERVICE_API_KEY=value", false).entries[0]?.kind).toBe("env");
  });

  it("reloads the canonical list after a set", async () => {
    const entry = { name: "SERVICE_URL", value: "https://service.test", kind: "env" as const };
    const { state, request } = storeWithSnapshots([entry]);
    await setSecretsStoreEntry(state, { ...entry, value: "draft", allowedHosts: "" });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "secrets.store.set",
      "secrets.store.list",
    ]);
    expect(state.entries).toEqual([entry]);
    expect(state.error).toBeNull();
  });

  it("reloads after every sequential bulk set", async () => {
    const { state, request } = storeWithSnapshots([], []);
    expect(
      await bulkSetSecretsStoreEntries(state, [
        { name: "ONE", value: "1", kind: "env" },
        { name: "TWO_TOKEN", value: "2", kind: "secret" },
      ]),
    ).toEqual({ saved: 2, warningCount: 0 });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "secrets.store.set",
      "secrets.store.list",
      "secrets.store.set",
      "secrets.store.list",
    ]);
  });

  it("sends parsed allowed hosts through the store RPC", async () => {
    const { state, request } = storeWithSnapshots([]);
    await setSecretsStoreEntry(state, {
      name: "SERVICE_API_KEY",
      value: "secret",
      kind: "secret",
      allowedHosts: "api.example.com, uploads.example.com\napi2.example.com",
    });
    expect(request).toHaveBeenNthCalledWith(1, "secrets.store.set", {
      name: "SERVICE_API_KEY",
      value: "secret",
      kind: "secret",
      allowedHosts: ["api.example.com", "uploads.example.com", "api2.example.com"],
    });
  });
});
