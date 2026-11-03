import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { SecretsPageState } from "./state.ts";
import { SecretsStore } from "./view.tsx";

function mount(
  entries: SecretStoreEntry[] | (() => SecretStoreEntry[]),
  overrides: Partial<SecretsPageState> = {},
  methods = ["secrets.store.list", "secrets.store.set", "secrets.store.delete"],
): HTMLElement {
  const source = createApplicationGateway();
  source.publish({
    ...source.gateway.snapshot,
    phase: "connected",
    client: createTestGatewayClient(async () => ({})),
    hello: gatewayHelloForMethods(methods),
  });
  // SAFETY: this unbound view owner only reads the Gateway capability for permissions.
  const context = { gateway: source.gateway } as ApplicationContext;
  const state = Object.assign(new SecretsPageState(context, vi.fn()), overrides);
  state.store.entries = typeof entries === "function" ? entries() : entries;
  const read = typeof entries === "function" ? entries : () => state.store.entries;
  return mountSolid(() => (
    <SecretsStore
      state={state}
      scope={state.store}
      read={read}
      busy={state.store.busy}
      onSubmit={(bulk) => void (bulk ? state.submitBulk() : state.submitDraft())}
      onRemove={(entry) => void state.removeEntry(entry)}
      bulkSecretCount={0}
      bulkEntryCount={0}
      bulkInvalidNames={[]}
    />
  )).container;
}

it("never renders a secret value even when hostile input carries one", () => {
  const env: SecretStoreEntry = {
    name: "SERVICE_URL",
    kind: "env",
    value: "https://service.test",
    scopeKind: "team",
    scopeId: "",
    createdAtMs: 1,
    updatedAtMs: 2,
    updatedBy: "Operator",
  };
  const secret = {
    ...env,
    name: "SERVICE_API_KEY",
    kind: "secret" as const,
    value: "must-never-render",
    allowedHosts: ["api.example.com"],
  };
  const container = mount([secret, env]);
  expect(container.innerHTML).not.toContain("must-never-render");
  expect(container.textContent).toContain("••••••••");
  expect(container.textContent).toContain("https://service.test");
  expect(container.textContent).toContain("api.example.com");
  expect(container.textContent).toContain("Protected secret");
  expect(container.textContent).toContain("Agent-readable environment");
});

it("shows the allowed-host field for secret add and edit dialogs", () => {
  const container = mount([], {
    dialogMode: "edit",
    draft: {
      name: "SERVICE_API_KEY",
      value: "replacement",
      kind: "secret",
      allowedHosts: "api.example.com",
    },
  });
  const field = container.querySelector<HTMLTextAreaElement>('textarea[name="allowed-hosts"]');
  expect(field?.value).toBe("api.example.com");
  expect(container.textContent).toContain("Exact hostnames only");
});

it("hides mutation controls when the gateway does not advertise them", () => {
  const container = mount([], {}, ["secrets.store.list"]);
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("Secrets");
});

it("uses the current system timezone for refreshed inventory timestamps", () => {
  const NativeDateTimeFormat = Intl.DateTimeFormat;
  let timeZone = "UTC";
  const formatter = vi
    .spyOn(Intl, "DateTimeFormat")
    .mockImplementation(function (locales, options) {
      return new NativeDateTimeFormat(locales, { ...options, timeZone });
    });
  try {
    const entry: SecretStoreEntry = {
      name: "SERVICE_URL",
      kind: "env",
      value: "https://service.test",
      scopeKind: "team",
      scopeId: "",
      createdAtMs: 1,
      updatedAtMs: Date.UTC(2026, 0, 1, 12),
    };
    const [entries, setEntries] = createSignal([entry]);
    const container = mount(() => entries());
    const title = () => container.querySelector("time")?.title;
    const expected = (ms: number) =>
      new NativeDateTimeFormat(i18n.getLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
      }).format(ms);
    expect(title()).toBe(expected(entry.updatedAtMs));

    timeZone = "America/Los_Angeles";
    const refreshed = { ...entry, updatedAtMs: entry.updatedAtMs + 60_000 };
    setEntries([refreshed]);
    flush();
    expect(title()).toBe(expected(refreshed.updatedAtMs));
  } finally {
    formatter.mockRestore();
  }
});
