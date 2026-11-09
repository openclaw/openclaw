import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { i18n } from "../../i18n/lib/translate.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import { createBoardWidget } from "../../lib/board/widget.test-support.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  BoardGrantedCapabilities,
  BoardPendingCapabilities,
} from "./board-widget-capabilities.solid.tsx";

it("keeps mixed named-query approval details localized when the locale changes", async () => {
  const previousLocale = i18n.getLocale();
  const translate = i18n.t.bind(i18n);
  const translation = vi
    .spyOn(i18n, "t")
    .mockImplementation((key, params) =>
      key === "board.widget.needsApproval"
        ? `Approval (${i18n.getLocale()})`
        : translate(key, params),
    );
  onTestFinished(async () => {
    translation.mockRestore();
    await i18n.setLocale(previousLocale);
  });
  await i18n.setLocale("en");
  const widget: BoardWidget = createBoardWidget({
    name: "fixture",
    grantState: "pending",
    declared: {
      netOrigins: ["https://example.com"],
      tools: ["health"],
      queries: [
        {
          name: "main-ci",
          bindingId: "github.actions.runs",
          params: {
            repository: "owner/repo",
            workflow: "ci.yml",
            branch: "main",
            status: null,
            created: null,
            perPage: 1,
            excludePullRequests: true,
          },
          fields: ["id", "conclusion"],
        },
      ],
    },
    declaredSummary: ["Network access: https://example.com", "Tool access: health"],
  });
  const mounted = mountSolid(() => (
    <>
      <BoardPendingCapabilities widget={widget} disabled={false} onGrant={() => {}} />
      <BoardGrantedCapabilities
        widget={{ ...widget, grantState: "granted" }}
        presentation="details"
      />
    </>
  ));
  const label = mounted.container.querySelector("strong")!;
  expect(label.textContent).toBe("Approval (en)");
  await i18n.setLocale("fr");
  flush();
  expect(label.textContent).toBe("Approval (fr)");
  const pending = mounted.container.querySelector('[data-test-id="board-pending"]')!;
  const granted = mounted.container.querySelector(".board-widget__menu-capabilities")!;
  expect(pending.textContent).toContain("Origines réseau");
  expect(pending.textContent).toContain("Outils et données de l’hôte");
  expect(granted.textContent).toContain("Réseau : https://example.com");
  expect(granted.textContent).toContain("Outil : health");
  for (const surface of [pending, granted]) {
    expect(surface.textContent).toContain(
      'repository="owner/repo"; workflow="ci.yml"; branch="main"; status=null; created=null; perPage=1; excludePullRequests=true',
    );
    expect(surface.textContent).toContain("fields=id, conclusion");
    expect(surface.textContent).toContain("résultats privés sélectionnés et les résultats futurs");
    expect(surface.textContent).not.toContain("Network access:");
    expect(surface.textContent).not.toContain("Tool access:");
  }
});

it("shows the exact action target both before approval and in granted details", async () => {
  const previous = i18n.getLocale();
  onTestFinished(() => i18n.setLocale(previous));
  await i18n.setLocale("en");
  const widget = createBoardWidget({
    grantState: "pending",
    declared: {
      actionBindings: [
        {
          name: "play",
          actionId: "device-controls.audio",
          params: { nodeId: "fixture-mac", operationId: "fixture-operation" },
        },
      ],
    },
  });
  const mounted = mountSolid(() => (
    <>
      <BoardPendingCapabilities widget={widget} disabled={false} onGrant={() => {}} />
      <BoardGrantedCapabilities
        widget={{ ...widget, grantState: "granted" }}
        presentation="details"
      />
    </>
  ));
  for (const surface of [
    mounted.container.querySelector('[data-test-id="board-pending"]'),
    mounted.container.querySelector(".board-widget__menu-capabilities"),
  ]) {
    expect(surface?.textContent).toContain('nodeId="fixture-mac"');
    expect(surface?.textContent).toContain('operationId="fixture-operation"');
    expect(surface?.textContent).toContain("device-controls.audio");
    expect(surface?.textContent).toContain("Requires interaction");
  }
});
