/* @vitest-environment jsdom */
import { render, type TemplateResult } from "lit";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
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

it.each([
  "file tabs",
  "agent selection",
  "empty draft",
  "external update",
  "matching external update",
  "pending save",
  "connection replacement",
  "reconnect",
])("retains an unsaved file edit across %s", async (transition) => {
  const roster = { ...agentsList, agents: [{ id: "main" }, { id: "research" }] };
  const fileList = (agentId: string) => ({
    agentId,
    workspace: `/tmp/${agentId}`,
    files: ["AGENTS.md", "SOUL.md"].map((name) => ({
      name,
      path: `/tmp/${agentId}/${name}`,
      missing: false,
    })),
  });
  let mainContent = "main AGENTS.md saved";
  let mainHash = "a".repeat(64);
  const draft = transition === "empty draft" ? "" : "unsaved local instructions";
  const pendingSave = createDeferred();
  const request = vi.fn(
    async (
      method: string,
      params: { agentId: string; name: string; content?: string; expectedHash?: string },
    ) => {
      if (method === "agents.files.set") {
        if (params.expectedHash !== mainHash) {
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
          missing: false,
          content:
            params.agentId === "main" && params.name === "AGENTS.md"
              ? mainContent
              : `${params.agentId} ${params.name} saved`,
          hash: mainHash,
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
      expect(page.agentFileContents[page.agentFileActive ?? ""]).toBeDefined();
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
    expect(textarea().value).toBe("main AGENTS.md saved");
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
      if (transition === "external update" || transition === "matching external update") {
        mainContent = transition === "external update" ? "changed on disk" : draft;
        mainHash = "b".repeat(64);
      } else if (transition === "connection replacement") {
        mainContent = "replacement Gateway instructions";
        const replacement = { request } as unknown as GatewayBrowserClient;
        page.gateway.applySnapshot(
          { ...connected, client: replacement },
          { initial: false, sourceChanged: false },
        );
        await settle();
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
    if (transition === "external update") {
      expect(page.agentFileContents["AGENTS.md"]).toBe("changed on disk");
      save().click();
      await vi.waitFor(() => {
        paint();
        expect(container.textContent).toContain("File changed on disk");
      });
      expect(request).toHaveBeenLastCalledWith("agents.files.set", {
        agentId: "main",
        name: "AGENTS.md",
        content: draft,
        expectedHash: "a".repeat(64),
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
      await vi.waitFor(() => expect(page.agentFileContents["AGENTS.md"]).toBe("next edit"));
      expect(save().disabled).toBe(true);
      expect(request).toHaveBeenLastCalledWith("agents.files.set", {
        agentId: "main",
        name: "AGENTS.md",
        content: "next edit",
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
