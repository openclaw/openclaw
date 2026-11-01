/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { GatewaySessionRow, ModelCatalogEntry } from "../../../api/types.ts";
import { createSessionsListResult } from "../../../test-helpers/chat-model.ts";
import { installModelPickerLayout } from "../../../test-helpers/model-picker-layout.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatModelControls } from "./chat-model-controls.tsx";

type Props = Parameters<typeof ChatModelControls>[0];

const runtime = { id: "openclaw", source: "model" } as const;

function catalogRows(contextWindow: number, contextTokens?: number): ModelCatalogEntry[] {
  return ["astra", "sol"].map((id) => ({
    id,
    name: id,
    provider: "example",
    available: true,
    contextWindow,
    contextTokens,
    agentRuntime: runtime,
  }));
}

async function pickerRows(
  selectedSession: GatewaySessionRow | undefined,
  catalog = catalogRows(872_000, 272_000),
) {
  installModelPickerLayout();
  const sessions = createSessionsListResult({
    model: "astra",
    modelProvider: "example",
    defaultsModel: "astra",
    defaultsProvider: "example",
  });
  const props: Props = {
    activeRunId: null,
    connected: true,
    gatewayAvailable: true,
    loading: false,
    modelSwitching: false,
    modelPickerOpen: true,
    modelCatalogState: { hasSnapshot: true, status: "ready" },
    sending: false,
    stream: null,
    sessionKey: "main",
    modelCatalog: catalog,
    selectedSession,
    sessionsResult: sessions,
    onModelSelect: vi.fn(async () => true),
  };
  const { container } = mountSolid(() => <ChatModelControls {...props} />);
  flush();
  await waitForSolid(() =>
    expect(container.querySelector('[data-chat-model-option="example/sol"]')).not.toBeNull(),
  );
  const row = (value: string) =>
    container.querySelector<HTMLElement>(`[data-chat-model-option="${value}"]`)?.textContent ?? "";
  return { selected: row("") || row("example/astra"), unselected: row("example/sol") };
}

it("shows the catalog's active budget beside the maximum without session metadata", async () => {
  const rows = await pickerRows(undefined);
  expect(rows.selected).toContain("272k active · 872k max");
  expect(rows.unselected).toContain("272k active · 872k max");
});

it("prefers the selected session's budget only for its own row", async () => {
  const sessions = createSessionsListResult({ model: "astra", modelProvider: "example" });
  const rows = await pickerRows({
    ...sessions.sessions[0]!,
    agentRuntime: runtime,
    contextTokens: 258_400,
  });
  expect(rows.selected).toContain("258.4k active · 872k max");
  expect(rows.unselected).toContain("272k active · 872k max");
});

it("shows only the session's runtime budget when the catalog maximum is smaller", async () => {
  const sessions = createSessionsListResult({ model: "astra", modelProvider: "example" });
  const rows = await pickerRows(
    { ...sessions.sessions[0]!, agentRuntime: runtime, contextTokens: 258_400 },
    catalogRows(128_000),
  );
  expect(rows.selected).toContain("258.4k");
  expect(rows.selected).not.toContain("max");
  expect(rows.unselected).toContain("128k");
});
