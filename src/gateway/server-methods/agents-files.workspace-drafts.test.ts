/* @vitest-environment jsdom */
import fs from "node:fs";
import path from "node:path";
import { render, type TemplateResult } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../../ui/src/api/gateway.ts";
import type { ApplicationContext } from "../../../ui/src/app/context.ts";
import {
  agentsCapability,
  agentsList,
  agentsRouteData,
  gateway,
  pageContext,
  settingsSelection,
  snapshot,
  type TestAgentsPage,
} from "../../../ui/src/pages/agents/agents-page.test-support.ts";
import "../../../ui/src/pages/agents/agents-page.ts";
import { gatewayHelloForMethods } from "../../../ui/src/test-helpers/gateway-methods.ts";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { agentFileHandlers } from "./agents-files.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["existing", "missing", "matching draft"])(
  "retains a mounted editor's workspace target (%s)",
  async (variant) => {
    const roster = { ...agentsList, agents: [{ id: "main" }, { id: "research" }] };
    const workspaceRoot = tempDirs.make("agent-file-workspace-");
    let mainWorkspace = path.join(workspaceRoot, "a");
    const researchWorkspace = path.join(workspaceRoot, "research");
    const workspaceFor = (agentId: string) =>
      agentId === "main" ? mainWorkspace : researchWorkspace;
    const mainMissing = variant === "missing";
    const fileList = (agentId: string) => ({
      agentId,
      workspace: workspaceFor(agentId),
      files: [
        {
          name: "AGENTS.md",
          path: path.join(workspaceFor(agentId), "AGENTS.md"),
          missing: agentId === "main" && mainMissing,
          expectedAbsent: true,
        },
      ],
    });
    let mainContent = mainMissing ? "" : "main AGENTS.md saved";
    for (const workspace of [mainWorkspace, path.join(workspaceRoot, "b"), researchWorkspace]) {
      fs.mkdirSync(workspace);
      if (mainMissing && workspace !== researchWorkspace) {
        continue;
      }
      fs.writeFileSync(
        path.join(workspace, "AGENTS.md"),
        `${workspace === researchWorkspace ? "research" : "main"} AGENTS.md saved`,
      );
    }
    const draft = "unsaved local instructions";
    let nextSaveRequested = createDeferred();
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
        if (method !== "agents.files.get" && method !== "agents.files.set") {
          throw new Error(`Unexpected file method ${method}`);
        }
        if (method === "agents.files.set") {
          nextSaveRequested.resolve();
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
    const loads = vi.spyOn(page, "loadAgentFiles");
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
    const save = () => {
      paint();
      const button = container.querySelector<HTMLButtonElement>(".agent-file-actions .primary");
      expect(button).not.toBeNull();
      return button!;
    };
    const selectAgent = async (agentId: string) => {
      selection.set(agentId);
      expect(loads).toHaveBeenLastCalledWith(agentId);
      await loads.mock.results.at(-1)?.value;
      expect(page.agentFilesList?.agentId).toBe(agentId);
      expect(page.agentFilesLoading).toBe(false);
    };
    try {
      await page.loadAgentFiles("main");
      expect(textarea().value).toBe(mainContent);
      const editor = textarea();
      expect(editor.disabled).toBe(false);
      editor.value = draft;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      expect(textarea().value).toBe(draft);
      await selectAgent("research");
      expect(textarea().value).toBe("research AGENTS.md saved");
      mainWorkspace = path.join(workspaceRoot, "b");
      if (variant === "matching draft") {
        mainContent = draft;
        fs.writeFileSync(path.join(mainWorkspace, "AGENTS.md"), draft);
      }
      await selectAgent("main");
      expect(textarea().value).toBe(draft);
      expect(request.mock.calls.every(([method]) => method === "agents.files.get")).toBe(true);
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
    } finally {
      page.subscriptions.hostDisconnected();
      selection.dispose();
      render(null, container);
    }
  },
);
