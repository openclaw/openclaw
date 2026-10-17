/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import {
  agentsCapability,
  agentsList,
  agentsRouteData,
  gateway,
  pageContext,
  settingsSelection,
  snapshot,
  createAgentsPage,
  emitGatewaySnapshot,
} from "./agents-page.test-support.ts";
import { Agents } from "./view.tsx";

type FileRequest = {
  agentId: string;
  name: string;
  content?: string;
  expectedHash?: string;
  expectedMissing?: true;
};

const writeParams = (
  content: string,
  version: { expectedHash: string } | { expectedMissing: true },
) => ({ agentId: "main", name: "AGENTS.md", content, ...version });

it.each([
  "file tabs",
  "empty draft",
  "external update",
  "missing file",
  "matching external update",
  "pending save",
  "connection replacement",
  "reconnect",
])("retains an unsaved file edit across %s", async (transition) => {
  const roster = { ...agentsList, agents: [{ id: "main" }, { id: "research" }] };
  let mainMissing = transition === "missing file";
  const fileList = (agentId: string) => ({
    agentId,
    workspace: `/tmp/${agentId}`,
    files: ["AGENTS.md", "SOUL.md"].map((name) => ({
      name,
      path: `/tmp/${agentId}/${name}`,
      missing: agentId === "main" && name === "AGENTS.md" && mainMissing,
      expectedAbsent: true,
    })),
  });
  let mainContent = mainMissing ? "" : "main AGENTS.md saved";
  let mainHash = "a".repeat(64);
  const draft = transition === "empty draft" ? "" : "unsaved local instructions";
  const pendingSave = createDeferred();
  const request = vi.fn(async (method: string, params: FileRequest) => {
    const { agentId, name, content, expectedHash, expectedMissing } = params;
    if (method === "agents.files.set") {
      if (expectedMissing ? !mainMissing : expectedHash !== mainHash) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "File changed on disk",
          details: { type: "agent_file_conflict" },
        });
      }
      mainContent = content ?? "";
      if (transition === "pending save") {
        mainHash = "c".repeat(64);
        await pendingSave.promise;
      }
    } else if (method !== "agents.files.get") {
      throw new Error(`Unexpected method ${method}`);
    }
    return {
      agentId,
      workspace: `/tmp/${agentId}`,
      file: {
        name,
        path: `/tmp/${agentId}/${name}`,
        missing: agentId === "main" && name === "AGENTS.md" && mainMissing,
        content:
          agentId === "main" && name === "AGENTS.md" ? mainContent : `${agentId} ${name} saved`,
        hash: agentId === "main" && mainMissing ? undefined : mainHash,
      },
    };
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const connected = { ...snapshot(client), hello: gatewayHelloForMethods(["agents.files.set"]) };
  const currentGateway = gateway(connected);
  const selection = settingsSelection(roster);
  const agents = agentsCapability(async () => fileList("main"));
  agents.state.agentsList = roster;
  agents.ensureFiles = vi.fn(async (agentId: string) => fileList(agentId));
  const context = pageContext(currentGateway, agents);
  Object.assign(context, { settingsAgentSelection: selection });
  Object.assign(context.runtimeConfig, { state: { configForm: {}, configSnapshot: {} } });
  const page = createAgentsPage(
    context,
    agentsRouteData(currentGateway, roster, "main", selection),
  );
  const mounted = mountSolid(Agents, page.read());
  const { container } = mounted;
  const paint = () => mounted.update(page.read());
  const files = () => page.read().agentFiles;
  const editorState = () => files().agentFileEditors["AGENTS.md"];
  const element = <T extends HTMLElement>(selector: string): T => {
    paint();
    const target = container.querySelector<T>(selector);
    expect(target).not.toBeNull();
    return target!;
  };
  const textarea = () => element<HTMLTextAreaElement>(".agent-file-textarea");
  const settle = async () => {
    await vi.waitFor(() => {
      expect(files().agentFileEditors[files().agentFileActive ?? ""]?.content).toBeDefined();
      expect(files().agentFilesList?.agentId).toBe(selection.state.selectedId);
      expect(files().agentFilesLoading).toBe(false);
      paint();
      expect(container.querySelector(".agent-file-textarea")).not.toBeNull();
    });
  };
  const tab = (name: string) =>
    element<HTMLButtonElement>(`.agent-file-tabs [role="tab"][data-tab-value="${name}"]`).click();
  const save = () => element<HTMLButtonElement>(".agent-file-actions .primary");
  try {
    await settle();
    const editor = textarea();
    expect(editor).toMatchObject({ value: mainContent, disabled: false });
    editor.value = draft;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    expect(textarea().value).toBe(draft);
    if (transition === "file tabs") {
      tab("SOUL.md");
      await settle();
      expect(textarea().value).toBe("main SOUL.md saved");
      tab("AGENTS.md");
    } else if (transition !== "reconnect") {
      if (transition === "pending save") {
        save().click();
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith(
            "agents.files.set",
            writeParams(draft, { expectedHash: "a".repeat(64) }),
          ),
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
        emitGatewaySnapshot(currentGateway, { ...connected, client: replacement });
        await settle();
      }
      selection.set("main");
    } else {
      emitGatewaySnapshot(currentGateway, { ...connected, phase: "reconnecting" });
      emitGatewaySnapshot(currentGateway, connected);
    }
    await settle();
    expect(textarea().value).toBe(transition === "connection replacement" ? mainContent : draft);
    if (transition !== "pending save") {
      expect(request.mock.calls.every(([method]) => method === "agents.files.get")).toBe(true);
    } else {
      expect(save().disabled).toBe(true);
    }
    if (transition === "external update" || transition === "missing file") {
      expect(editorState()?.content).toBe("changed on disk");
      save().click();
      await vi.waitFor(() => {
        paint();
        expect(container.textContent).toContain("File changed on disk");
      });
      expect(request).toHaveBeenLastCalledWith(
        "agents.files.set",
        writeParams(
          draft,
          transition === "missing file"
            ? { expectedMissing: true }
            : { expectedHash: "a".repeat(64) },
        ),
      );
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
      await vi.waitFor(() => expect(editorState()?.content).toBe("next edit"));
      expect(save().disabled).toBe(true);
      expect(request).toHaveBeenLastCalledWith(
        "agents.files.set",
        writeParams("next edit", { expectedHash: "b".repeat(64) }),
      );
    }
  } finally {
    pendingSave.resolve();
    selection.dispose();
  }
});
