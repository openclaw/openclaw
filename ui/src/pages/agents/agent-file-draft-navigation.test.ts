/* @vitest-environment jsdom */
import fs from "node:fs";
import path from "node:path";
import { render, type TemplateResult } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  agentsCapability,
  agentsList,
  agentsRouteData,
  gateway,
  pageContext,
  settingsSelection,
  snapshot,
  type TestAgentsPage,
} from "./agents-page.test-support.ts";
import "./agents-page.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  "file tabs",
  "empty draft",
  "external update",
  "missing file",
  "matching external update",
  "pending save",
  "connection replacement",
  "reconnect",
  "workspace change",
  "missing workspace change",
  "matching workspace change",
])("retains an unsaved file edit across %s", async (transition) => {
  const roster = { ...agentsList, agents: [{ id: "main" }, { id: "research" }] };
  const changesWorkspace = transition.includes("workspace change");
  const workspaceRoot = changesWorkspace ? tempDirs.make("agent-file-workspace-") : null;
  const { agentFileHandlers } = changesWorkspace
    ? await import("../../../../src/gateway/server-methods/agents-files.js")
    : { agentFileHandlers: null };
  let mainWorkspace = workspaceRoot ? path.join(workspaceRoot, "a") : "/tmp/main";
  const researchWorkspace = workspaceRoot ? path.join(workspaceRoot, "research") : "/tmp/research";
  const workspaceFor = (agentId: string) =>
    agentId === "main" ? mainWorkspace : researchWorkspace;
  let mainMissing = transition === "missing file" || transition === "missing workspace change";
  const fileList = (agentId: string) => ({
    agentId,
    workspace: workspaceFor(agentId),
    files: ["AGENTS.md", "SOUL.md"].map((name) => ({
      name,
      path: path.join(workspaceFor(agentId), name),
      missing: agentId === "main" && name === "AGENTS.md" && mainMissing,
      expectedAbsent: true,
    })),
  });
  let mainContent = mainMissing ? "" : "main AGENTS.md saved";
  if (workspaceRoot) {
    for (const workspace of [mainWorkspace, path.join(workspaceRoot, "b"), researchWorkspace]) {
      fs.mkdirSync(workspace);
      for (const name of ["AGENTS.md", "SOUL.md"]) {
        if (name === "AGENTS.md" && mainMissing && workspace !== researchWorkspace) {
          continue;
        }
        fs.writeFileSync(
          path.join(workspace, name),
          `${workspace === researchWorkspace ? "research" : "main"} ${name} saved`,
        );
      }
    }
  }
  let mainHash = "a".repeat(64);
  const draft = transition === "empty draft" ? "" : "unsaved local instructions";
  const pendingSave = createDeferred();
  let nextSaveRequested: ReturnType<typeof createDeferred<void>> | undefined;
  const request = vi.fn(
    async (
      method: string,
      params: {
        agentId: string;
        name: string;
        content?: string;
        expectedHash?: string;
        expectedWorkspace?: string;
        expectedMissing?: true;
      },
    ) => {
      if (method === "agents.files.set") {
        nextSaveRequested?.resolve();
      }
      if (agentFileHandlers) {
        if (method !== "agents.files.get" && method !== "agents.files.set") {
          throw new Error(`Unexpected file method ${method}`);
        }
        let result: unknown;
        await agentFileHandlers[method]({
          req: { type: "req", id: method, method, params },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond: (ok, payload, error) => {
            if (!ok && error) {
              throw new GatewayRequestError(error);
            }
            result = payload;
          },
          context: {
            getRuntimeConfig: (): OpenClawConfig => ({
              agents: {
                ownership: "explicit",
                defaults: { systemAgent: { agentId: "main" } },
                entries: {
                  main: { workspace: mainWorkspace },
                  research: { workspace: researchWorkspace },
                },
              },
            }),
          } as never,
        });
        return result;
      }
      if (method === "agents.files.set") {
        if (params.expectedMissing ? !mainMissing : params.expectedHash !== mainHash) {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "File changed on disk",
            details: { type: "agent_file_conflict" },
          });
        }
        mainContent = params.content ?? "";
        if (transition === "pending save") {
          mainHash = "c".repeat(64);
          await pendingSave.promise;
        }
      } else if (method !== "agents.files.get") {
        throw new Error(`Unexpected method ${method}`);
      }
      return {
        agentId: params.agentId,
        workspace: `/tmp/${params.agentId}`,
        file: {
          name: params.name,
          path: `/tmp/${params.agentId}/${params.name}`,
          missing: params.agentId === "main" && params.name === "AGENTS.md" && mainMissing,
          content:
            params.agentId === "main" && params.name === "AGENTS.md"
              ? mainContent
              : `${params.agentId} ${params.name} saved`,
          hash: params.agentId === "main" && mainMissing ? undefined : mainHash,
        },
      };
    },
  );
  const client = { request } as unknown as GatewayBrowserClient;
  const connected = { ...snapshot(client), hello: gatewayHelloForMethods(["agents.files.set"]) };
  const currentGateway = gateway(connected);
  const selection = settingsSelection(roster);
  const agents = {
    ...agentsCapability(async () => fileList("main")),
    state: { ...agentsCapability(async () => fileList("main")).state, agentsList: roster },
    files: () => ({ list: null, loading: false, error: null }),
    ensureFiles: vi.fn(async (agentId: string) => fileList(agentId)),
    recordFile: vi.fn(),
  };
  const page = document.createElement("openclaw-agents-page") as TestAgentsPage & {
    render: () => TemplateResult;
    agentFileSaving: boolean;
  };
  page.context = {
    ...pageContext(currentGateway, agents),
    basePath: "",
    settingsAgentSelection: selection,
    gateway: { ...currentGateway, connection: { password: "" } },
    channels: { state: {}, subscribe: () => () => undefined },
    runtimeConfig: {
      state: { configForm: {}, configSnapshot: {} },
      subscribe: () => () => undefined,
    },
    navigation: { snapshot: { pinnedAgentIds: [] }, subscribe: () => () => undefined },
  } as unknown as ApplicationContext;
  page.gateway.applySnapshot(connected, { initial: true, sourceChanged: false });
  page.routeData = agentsRouteData(currentGateway, roster, "main", selection);
  page.subscriptions.hostConnected();
  page.routeDataInitialized = true;
  const container = document.createElement("div");
  const paint = () => render(page.render(), container);
  const textarea = () => {
    paint();
    const input = container.querySelector<HTMLTextAreaElement>(".agent-file-textarea");
    expect(input).not.toBeNull();
    return input!;
  };
  const settle = async () => {
    await vi.waitFor(() => {
      expect(page.agentFileEditors[page.agentFileActive ?? ""]?.content).toBeDefined();
      expect(page.agentFilesList?.agentId).toBe(selection.state.selectedId);
      expect(page.agentFilesLoading).toBe(false);
      paint();
      expect(container.querySelector(".agent-file-textarea")).not.toBeNull();
    });
  };
  const tab = (name: string) => {
    paint();
    const target = container.querySelector(`[panel="${name}"]`);
    expect(target).not.toBeNull();
    target!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  };
  const save = () => {
    paint();
    const button = container.querySelector<HTMLButtonElement>(".agent-file-actions .primary");
    expect(button).not.toBeNull();
    return button!;
  };
  try {
    await page.loadAgentFiles("main");
    await settle();
    expect(textarea().value).toBe(mainContent);
    const editor = textarea();
    expect(editor.disabled).toBe(false);
    editor.value = draft;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    expect(textarea().value).toBe(draft);
    if (transition === "file tabs") {
      tab("SOUL.md");
      await settle();
      expect(textarea().value).toBe("main SOUL.md saved");
      tab("AGENTS.md");
      await settle();
    } else if (transition !== "reconnect") {
      if (transition === "pending save") {
        save().click();
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith("agents.files.set", {
            agentId: "main",
            name: "AGENTS.md",
            content: draft,
            expectedWorkspace: "/tmp/main",
            expectedHash: "a".repeat(64),
          }),
        );
      }
      selection.set("research");
      await settle();
      expect(textarea().value).toBe("research AGENTS.md saved");
      if (transition === "pending save") {
        pendingSave.resolve();
        await request.mock.results.find(
          (_, index) => request.mock.calls[index]?.[0] === "agents.files.set",
        )?.value;
        expect(textarea().value).toBe("research AGENTS.md saved");
      }
      if (
        transition === "external update" ||
        transition === "missing file" ||
        transition === "matching external update"
      ) {
        mainContent = transition === "matching external update" ? draft : "changed on disk";
        mainHash = "b".repeat(64);
        mainMissing = false;
      } else if (transition === "connection replacement") {
        mainContent = "replacement Gateway instructions";
        const replacement = { request } as unknown as GatewayBrowserClient;
        page.gateway.applySnapshot(
          { ...connected, client: replacement },
          { initial: false, sourceChanged: false },
        );
        await settle();
      }
      if (workspaceRoot) {
        mainWorkspace = path.join(workspaceRoot, "b");
        if (transition === "matching workspace change") {
          mainContent = draft;
          fs.writeFileSync(path.join(mainWorkspace, "AGENTS.md"), draft);
        }
      }
      selection.set("main");
      await settle();
    } else {
      page.gateway.applySnapshot(
        { ...connected, phase: "reconnecting" },
        { initial: false, sourceChanged: false },
      );
      page.gateway.applySnapshot(connected, { initial: false, sourceChanged: false });
      await settle();
    }
    expect(textarea().value).toBe(transition === "connection replacement" ? mainContent : draft);
    if (transition !== "pending save") {
      expect(request.mock.calls.every(([method]) => method === "agents.files.get")).toBe(true);
    } else {
      expect(save().disabled).toBe(true);
    }
    if (workspaceRoot) {
      save().click();
      await request.mock.results.at(-1)?.value.catch(() => undefined);
      expect(page.agentFileSaving).toBe(false);
      expect(textarea().value).toBe(draft);
      expect(
        mainMissing
          ? fs.existsSync(path.join(mainWorkspace, "AGENTS.md"))
          : fs.readFileSync(path.join(mainWorkspace, "AGENTS.md"), "utf8"),
      ).toBe(mainMissing ? false : mainContent);
      expect(container.querySelector(".callout.danger")?.textContent).toContain("workspace");
      const action = mainMissing ? "Reload" : "Overwrite";
      const recovery = Array.from(
        container.querySelectorAll<HTMLButtonElement>(".callout.danger button"),
      ).find((button) => button.textContent?.trim() === action);
      expect(recovery).toBeDefined();
      nextSaveRequested = createDeferred();
      recovery!.click();
      if (!mainMissing) {
        await nextSaveRequested.promise;
      }
      await request.mock.results.at(-1)?.value;
      expect(page.agentFilesLoading).toBe(false);
      expect(page.agentFileSaving).toBe(false);
      paint();
      expect(container.querySelector(".callout.danger")).toBeNull();
      expect(textarea().value).toBe(mainMissing ? "" : draft);
      expect(save().disabled).toBe(true);
      if (!mainMissing) {
        expect(fs.readFileSync(path.join(mainWorkspace, "AGENTS.md"), "utf8")).toBe(draft);
      }
      const originalPath = path.join(workspaceRoot, "a", "AGENTS.md");
      expect(
        mainMissing ? fs.existsSync(originalPath) : fs.readFileSync(originalPath, "utf8"),
      ).toBe(mainMissing ? false : "main AGENTS.md saved");
    } else if (transition === "external update" || transition === "missing file") {
      expect(page.agentFileEditors["AGENTS.md"]?.content).toBe("changed on disk");
      save().click();
      await vi.waitFor(() => {
        paint();
        expect(container.textContent).toContain("File changed on disk");
      });
      expect(request).toHaveBeenLastCalledWith("agents.files.set", {
        agentId: "main",
        name: "AGENTS.md",
        content: draft,
        expectedWorkspace: "/tmp/main",
        ...(transition === "missing file"
          ? { expectedMissing: true }
          : { expectedHash: "a".repeat(64) }),
      });
      selection.set("research");
      await settle();
      selection.set("main");
      await settle();
      expect(textarea().value).toBe(draft);
      expect(container.querySelector(".callout.danger")?.textContent).toContain("Overwrite");
    } else if (transition === "matching external update") {
      expect(save().disabled).toBe(true);
      const next = textarea();
      next.value = "next edit";
      next.dispatchEvent(new Event("input", { bubbles: true }));
      save().click();
      await vi.waitFor(() => expect(page.agentFileEditors["AGENTS.md"]?.content).toBe("next edit"));
      expect(save().disabled).toBe(true);
      expect(request).toHaveBeenLastCalledWith("agents.files.set", {
        agentId: "main",
        name: "AGENTS.md",
        content: "next edit",
        expectedWorkspace: "/tmp/main",
        expectedHash: "b".repeat(64),
      });
    }
  } finally {
    pendingSave.resolve();
    page.subscriptions.hostDisconnected();
    selection.dispose();
    render(null, container);
  }
});
