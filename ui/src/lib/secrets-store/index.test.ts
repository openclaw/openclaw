import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  bulkSetSecretsStoreEntries,
  createInitialSecretsStoreState,
  parseSecretsStoreBulkInput,
  setSecretsStoreEntry,
} from "./index.ts";

function storeWithSnapshots(...snapshots: unknown[][]) {
  const responses = snapshots.flatMap((entries) => [{ ok: true, reloaded: false }, { entries }]);
  const request = vi.fn(async (_method: string, _params?: unknown) => responses.shift());
  const client = { request } as unknown as GatewayBrowserClient;
  return { state: createInitialSecretsStoreState({ client, connected: true }), request };
}

describe("secrets store state", () => {
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
