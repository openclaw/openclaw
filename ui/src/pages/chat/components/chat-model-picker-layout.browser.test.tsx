import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import type { GatewaySessionRow, ModelCatalogEntry } from "../../../api/types.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerControlsFixture,
  createComposerProps,
  renderComposerInto,
  resetComposerFixture,
} from "../chat-composer.test-support.ts";
import { ChatPaneModelControl } from "../chat-pane-model-control.tsx";
import type { ChatComposerSnapshot } from "../session-message-cache.ts";
import { prepareComposerWidthEdge } from "./chat-composer-width-ref.tsx";
import "../../../styles/chat.ts";
import "../../../styles/chat/composer.css";
import "../../../styles/chat/composer-surface.css";
import "../../../styles.css";

afterEach(() => resetComposerFixture());
const frame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

it("keeps the same saved label readable after a live-runtime round trip", async () => {
  await page.viewport(1280, 900);
  await prepareComposerWidthEdge();
  const root = document.body.appendChild(document.createElement("section"));
  root.className = "chat";
  root.style.cssText = "display:block;position:fixed;top:0;left:0;width:560px;height:500px";
  const transcript = root.appendChild(document.createElement("div"));
  transcript.className = "chat-thread";
  transcript.style.cssText = "height:200px;--chat-thread-inline-inset:0px;--chat-details-space:0px";
  const container = createComposerContainer();
  container.className = "chat-footer";
  root.append(container);
  onTestFinished(() => root.remove());
  const changed = vi.fn();
  const entry: ModelCatalogEntry = {
    id: "alpha-research",
    provider: "openai",
    name: "Alpha Research Extended Context Model",
    reasoning: true,
    available: true,
    agentRuntime: { id: "openclaw", source: "model" },
    runtimeChoices: ["openclaw", "codex"].map((id) => ({
      agentRuntime: { id, source: "model" },
      available: true,
    })),
  };
  const saved: ChatComposerSnapshot = {
    id: entry.id,
    provider: entry.provider,
    name: entry.name,
    reasoning: true,
    thinkingLevel: "high",
    thinkingDefault: "medium",
    thinkingLevels: [{ id: "high", label: "High" }],
  };
  const session: GatewaySessionRow = {
    key: "main",
    kind: "direct",
    updatedAt: 1,
    model: entry.id,
    modelProvider: entry.provider,
    modelOverrideSource: "user",
    thinkingLevel: "high",
    thinkingDefault: "medium",
    thinkingLevels: [{ id: "high", label: "High" }],
    contextTokens: 128000,
    agentRuntime: { id: "codex", source: "model" },
  };
  const controls = createComposerControlsFixture().model;
  let current = createComposerProps();
  const states = [];
  const html = [];
  const labels: HTMLElement[] = [];
  // Exercise the retained composer, not a remount: WebKit lost intrinsic width
  // after the longer live runtime label returned to the same saved model.
  for (const stale of [true, false, true]) {
    const selectedSession = { ...session };
    current = createComposerProps({
      ...current,
      selectedSession,
      modelCatalog: [{ ...entry }],
      onComposerWidthChange: changed,
      getTranscriptElement: () => transcript,
      composerControls: {
        component: ChatPaneModelControl,
        model: {
          ...controls,
          connected: true,
          gatewayAvailable: true,
          modelCatalog: [{ ...entry }],
          modelCatalogState: { hasSnapshot: true, status: "ready" },
          selectedSession,
          thinkingSession: selectedSession,
          snapshot: stale ? saved : undefined,
          sessionsResult: {
            ts: 1,
            count: 1,
            path: "",
            sessions: [selectedSession],
            defaults: {
              contextTokens: 128000,
              model: entry.id,
              modelProvider: entry.provider,
            },
          },
        },
      },
    });
    renderComposerInto(container, current);
    flush();
    await waitForSolid(() =>
      expect(
        container
          .querySelector("[data-chat-model-select] .chat-controls__inline-select-label")
          ?.textContent?.trim(),
      ).toBe(stale ? entry.name : `${entry.name} codex`),
    );
    await frame();
    await frame();
    await frame();
    const label = container.querySelector<HTMLElement>(
      "[data-chat-model-select] .chat-controls__inline-select-label",
    )!;
    const shell = container.querySelector<HTMLElement>(".agent-chat__composer-shell")!;
    const group = container.querySelector<HTMLElement>(".agent-chat__composer-controls")!;
    expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
    expect(label.clientWidth).toBeGreaterThan(0);
    labels.push(label);
    states.push({
      text: label.textContent,
      visible: label.clientWidth,
      natural: label.scrollWidth,
      composer: shell.getBoundingClientRect().width,
      controls: group.getBoundingClientRect().width,
    });
    html.push(container.querySelector(".chat-composer-model-control")!.outerHTML);
  }
  expect(changed).not.toHaveBeenCalled();
  expect(labels[2]).toBe(labels[0]);
  expect(html[2]).toEqual(html[0]);
  expect(states[0]!.visible).toBe(states[0]!.natural);
  expect(states[2]).toEqual(states[0]);
});
