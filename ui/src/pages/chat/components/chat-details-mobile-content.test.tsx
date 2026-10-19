/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  ChatDetailsMobileContent,
  type ChatDetailsMobilePage,
} from "./chat-details-mobile-content.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";

function details(overrides: Partial<ChatDetailsProps> = {}): ChatDetailsProps {
  return {
    sessionKey: "agent:main:details",
    currentAgentId: "main",
    messages: [],
    selectedSession: { key: "agent:main:details", kind: "direct" },
    ...overrides,
  };
}
function rootContent(): Extract<ChatDetailsMobilePage, { kind: "root" }>["content"] {
  return {
    entries: {
      labels: {
        people: "People",
        taskProgress: "Task progress",
        subagents: "Subagents",
        processes: "Processes",
        environment: "Environment",
        context: "Context",
        pullRequests: "Pull requests",
        automations: "Automations",
        generatedFiles: "Generated files",
        session: "Session",
      },
      people: { label: "People" },
      versions: { label: "Versions", metadata: 1 },
      onNavigate: vi.fn(),
    },
    processes: undefined,
    subagents: { workingLabel: "Working", onOpenSubagent: vi.fn(), onOpenSubagents: vi.fn() },
  };
}

it("shows a real worker without legacy fields and lets the environment owner decide empty state", () => {
  const active: GatewaySessionRow = {
    key: "agent:main:details",
    kind: "direct",
    placement: {
      state: "active",
      generation: 1,
      createdAtMs: 100000,
      updatedAtMs: 300000,
      stateChangedAtMs: 300000,
      environmentId: "worker:device",
      activeOwnerEpoch: 1,
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "base-manifest",
      remoteWorkspaceDir: "/worker/repo",
      runner: { kind: "device", status: "available" },
    },
  };
  const [value, setValue] = createSignal(details({ selectedSession: active }));
  const [presented, setPresented] = createSignal(true);
  const request = vi.fn();
  const openMachine = vi.fn();
  const content = rootContent();
  content.environment = { onRequestUncommitted: request, onOpenMachine: openMachine };
  const view = mountSolid(() => (
    <ChatDetailsMobileContent
      details={value()}
      presented={presented()}
      page={{ kind: "root", content }}
    />
  ));
  view.getByRole("button", { name: "worker:device" }).click();
  expect(openMachine).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledOnce();
  setValue(
    details({
      selectedSession: { key: "agent:main:details", kind: "direct", execNode: "Local Gateway" },
    }),
  );
  flush();
  expect(view.queryByRole("region", { name: "Environment" })).toBeNull();
  expect(request).toHaveBeenCalledOnce();
  setValue(details());
  flush();
  expect(view.queryByRole("region", { name: "Environment" })).toBeNull();
  expect(request).toHaveBeenCalledOnce();
  setPresented(false);
  flush();
  setPresented(true);
  flush();
  expect(request).toHaveBeenCalledTimes(2);
});

it("retains Outputs demand across publications and returns navigation origins without a second route owner", () => {
  const release = vi.fn();
  const retain = vi.fn(() => release);
  const output = {
    artifacts: [],
    artifactsLoading: false,
    artifactsError: null,
    dashboard: null,
    dashboardError: null,
    onOpenArtifact: vi.fn(),
    renderArtifactIcon: () => null,
    onViewAll: vi.fn(),
    renderViewAllIcon: () => null,
  };
  const [value, setValue] = createSignal(details({ outputs: output, retainOutputs: retain }));
  const [presented, setPresented] = createSignal(true);
  const content = rootContent();
  const [page, setPage] = createSignal<ChatDetailsMobilePage>({ kind: "root", content });
  const view = mountSolid(() => (
    <ChatDetailsMobileContent details={value()} presented={presented()} page={page()} />
  ));
  expect(retain).toHaveBeenCalledOnce();
  const people = view.getByRole("button", { name: "People" });
  people.click();
  expect(content.entries.onNavigate).toHaveBeenCalledWith(
    { kind: "people" },
    { kind: "details-root", trigger: people },
  );
  view.getByRole("button", { name: /Versions/ }).click();
  expect(content.entries.onNavigate).toHaveBeenLastCalledWith(
    { kind: "versions" },
    expect.objectContaining({ kind: "details-root" }),
  );
  setValue((current) => ({ ...current, outputs: { ...output, artifactsLoading: true } }));
  flush();
  expect(retain).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  setPage({ kind: "outputs" });
  flush();
  expect(retain).toHaveBeenCalledOnce();
  setPage({ kind: "context" });
  flush();
  expect(release).toHaveBeenCalledOnce();
  setPage({ kind: "root", content });
  flush();
  expect(retain).toHaveBeenCalledTimes(2);
  setPresented(false);
  flush();
  expect(release).toHaveBeenCalledTimes(2);
  const hiddenPeople = view.getByRole("button", { name: "People" });
  expect(hiddenPeople.hasAttribute("disabled")).toBe(true);
  hiddenPeople.click();
  expect(content.entries.onNavigate).toHaveBeenCalledTimes(2);
  setPresented(true);
  flush();
  expect(retain).toHaveBeenCalledTimes(3);
  expect(view.getByRole("button", { name: "People" })).toBe(hiddenPeople);
  const releaseReplacement = vi.fn();
  const retainReplacement = vi.fn(() => releaseReplacement);
  setValue((current) => ({ ...current, retainOutputs: retainReplacement }));
  flush();
  expect(release).toHaveBeenCalledTimes(3);
  expect(retainReplacement).toHaveBeenCalledOnce();
  expect(view.getByRole("button", { name: "People" })).toBe(hiddenPeople);
  view.unmount();
  expect(release).toHaveBeenCalledTimes(3);
  expect(releaseReplacement).toHaveBeenCalledOnce();
});
