/* @vitest-environment jsdom */

import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { i18n } from "../../i18n/index.ts";
import { createInitializationContext } from "../../pages/chat/chat-pane.test-support.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  mountPanel as mount,
  panelButton,
  panelTestStorage,
} from "./terminal-panel-lifecycle.test-support.ts";
import { createTerminalPanelUpload, type TerminalPanelUpload } from "./terminal-panel-upload.ts";
import {
  createTerminalController,
  createTerminalGatewayClient,
  createTestTerminalPanel,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";

const TERMINAL_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const panelTag = defineTestTerminalPanelElement(createGhosttyTerminalMock);

panelTestStorage(createGhosttyTerminalMock, false, () => {
  vi.restoreAllMocks();
  return i18n.setLocale("en");
});

function terminalUploadFile(name: string, content: string): File {
  const file = new File([content], name);
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(content).buffer,
  });
  return file;
}

async function mountReadyPanel(client: TerminalGatewayClient) {
  const panel = mount(panelTag, { client, available: true }, false);
  panel.toggle();
  await panel.updateComplete;
  await vi.dynamicImportSettled();
  await waitForFast(() => expect(panelButton(panel, ".tp-upload")?.disabled).toBe(false));
  return panel;
}

function uploadClient(upload: (params: unknown, signal?: AbortSignal) => unknown) {
  return createTerminalGatewayClient(
    async <T>(method: string, params?: unknown, options?: { signal?: AbortSignal }) =>
      (method === "terminal.open"
        ? terminalOpenResult("session-1")
        : method === "terminal.upload"
          ? await upload(params, options?.signal)
          : { ok: true }) as T,
  );
}

function dropFiles(panel: OpenClawTerminalPanel, files: File[]) {
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", {
    value: { types: ["Files"], files, dropEffect: "none" },
  });
  panel.querySelector(".tp-viewport")?.dispatchEvent(drop);
}

describe("OpenClawTerminalPanel upload lifecycle", () => {
  it("does not request an upload after a pending file read is disabled", async () => {
    const base = createApplicationConfigCapability({ resourceBasePath: "" });
    const config = { ...base, current: { ...base.current, uploadsEnabled: true } };
    const request = vi.fn();
    const terminal = createTerminalController();
    const tab = {
      gatewaySessionId: "session-1",
      shell: "/bin/sh",
      status: "live",
      controller: terminal as unknown as GhosttyTerminalController,
    };
    let upload!: TerminalPanelUpload;
    mountSolid(() => {
      upload = createTerminalPanelUpload({
        config: () => config,
        activeTab: () => tab,
        client: () => ({ request, forceReconnect: () => {}, addEventListener: () => () => {} }),
        isCurrent: () => true,
        fileInput: () => null,
        setError: vi.fn(),
      });
      return null;
    });
    const read = createDeferred<ArrayBuffer>();
    const file = new File(["file"], "file.txt");
    Object.defineProperty(file, "arrayBuffer", { value: () => read.promise });
    const drop = new Event("drop", { cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [file] } });
    upload.handleDrop(drop as DragEvent);
    expect(upload.hasPendingBatch()).toBe(true);
    config.current.uploadsEnabled = false;
    read.resolve(new ArrayBuffer(1));
    await read.promise;
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(terminal.terminal.paste).not.toHaveBeenCalled();
    expect(upload.hasPendingBatch()).toBe(false);
  });
  it("reacts to mobile upload policy changes without intercepting text drops", async () => {
    const config = createApplicationConfigCapability({ resourceBasePath: "" });
    const host = createApplicationContextProvider({ ...createInitializationContext(), config });
    const panel = Object.assign(createTestTerminalPanel(panelTag), {
      embedded: true,
      mobile: true,
      available: true,
    });
    host.append(panel);
    document.body.append(host);
    await panel.updateComplete;
    const staleInput = panel.querySelector<HTMLInputElement>(".tp-file-input")!;
    expect(staleInput).not.toBeNull();
    let enabled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ uploadsEnabled: enabled }))),
    );
    await config.refresh();
    await panel.updateComplete;
    expect(panel.querySelector(".tp-file-input")).toBeNull();
    expect(panel.querySelector(".tp-upload")).toBeNull();
    const read = vi.fn();
    const file = new File(["test"], "test.txt");
    Object.defineProperty(file, "arrayBuffer", { value: read });
    Object.defineProperty(staleInput, "files", { value: [file] });
    staleInput.dispatchEvent(new Event("change"));
    const viewport = panel.querySelector(".tp-viewport")!;
    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const transfer = { types: ["Files"], files: [file], dropEffect: "copy" };
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      viewport.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      if (type !== "drop") {
        expect(transfer.dropEffect).toBe("none");
      }
    }
    expect(read).not.toHaveBeenCalled();
    expect(panel.querySelector(".tp-upload-progress")).toBeNull();
    const textDrop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(textDrop, "dataTransfer", {
      value: { types: ["text/plain"], files: [] },
    });
    viewport.dispatchEvent(textDrop);
    expect(textDrop.defaultPrevented).toBe(false);
    enabled = true;
    await config.refresh();
    await panel.updateComplete;
    expect(panel.querySelector(".tp-file-input")).not.toBeNull();
    expect(panel.querySelector(".tp-upload")).not.toBeNull();
  });
  it.each(["retry", "expired-retry", "expired-insert", "expired-completion"] as const)(
    "preserves completed upload paths during %s recovery",
    async (recovery) => {
      const readNow = Date.now;
      let elapsedMs = 0;
      vi.spyOn(Date, "now").mockImplementation(() => readNow() + elapsedMs);
      const controller = createTerminalController();
      createGhosttyTerminalMock.mockResolvedValue(controller);
      const uploads: string[] = [];
      const failedUpload = createDeferred<{ path: string; size: number }>();
      let notesAttempts = 0;
      const client = uploadClient((params) => {
        const name = (params as { name: string }).name;
        uploads.push(name);
        if (name === "scan final.pdf") {
          return { path: "/tmp/openclaw upload/scan final.pdf", size: 3 };
        }
        return ++notesAttempts === 1
          ? failedUpload.promise
          : { path: "/tmp/openclaw upload/notes.txt", size: 4 };
      });
      const panel = await mountReadyPanel(client);
      dropFiles(panel, [
        terminalUploadFile("scan final.pdf", "pdf"),
        terminalUploadFile("notes.txt", "note"),
      ]);

      await waitForFast(() => {
        const progress = panel.querySelector(".tp-upload-progress");
        expect(progress?.getAttribute("aria-valuenow")).toBe("1");
        expect(progress?.getAttribute("aria-valuemax")).toBe("2");
        expect(panel.querySelector(".tp-upload-card")?.textContent).toContain("Uploading 2 of 2");
        expect(panel.querySelector(".tp-upload-card")?.textContent).toContain("notes.txt");
      });
      expect(controller.terminal.paste).not.toHaveBeenCalled();

      const expectExpiredBatch = async () => {
        await waitForFast(() => {
          expect(panel.querySelector(".tp-upload-card--failed")?.textContent).toContain(
            "Uploaded files may have expired. Cancel this batch and choose the files again.",
          );
          expect(panel.querySelector(".tp-upload-retry")).toBeNull();
          expect(panel.querySelector(".tp-upload-insert")).toBeNull();
        });
        expect(controller.terminal.paste).not.toHaveBeenCalled();
        expect(uploads).toHaveLength(2);
      };
      if (recovery === "expired-completion") {
        elapsedMs = TERMINAL_UPLOAD_RETENTION_MS;
        failedUpload.resolve({ path: "/tmp/openclaw upload/notes.txt", size: 4 });
        await expectExpiredBatch();
        return;
      }

      failedUpload.reject(
        Object.assign(new Error("terminal upload staging is full"), {
          gatewayCode: "UNAVAILABLE",
          retryable: false,
        }),
      );
      await waitForFast(() => {
        const failed = panel.querySelector(".tp-upload-card--failed");
        expect(failed?.textContent).toContain("Upload failed");
        expect(failed?.textContent).toContain("terminal upload staging is full");
        expect(panelButton(panel, ".tp-upload-retry")).not.toBeNull();
        if (recovery === "expired-insert") {
          expect(panelButton(panel, ".tp-upload-insert")).not.toBeNull();
        }
      });

      if (recovery === "expired-retry" || recovery === "expired-insert") {
        elapsedMs = TERMINAL_UPLOAD_RETENTION_MS;
        panelButton(
          panel,
          recovery === "expired-retry" ? ".tp-upload-retry" : ".tp-upload-insert",
        )?.click();
        await expectExpiredBatch();
        return;
      }
      panelButton(panel, ".tp-upload-retry")?.click();

      await waitForFast(() => {
        expect(controller.terminal.paste).toHaveBeenCalledWith(
          "'/tmp/openclaw upload/scan final.pdf' '/tmp/openclaw upload/notes.txt'",
        );
        expect(panel.querySelector(".tp-upload-card")).toBeNull();
      });
      expect(uploads).toEqual(["scan final.pdf", "notes.txt", "notes.txt"]);
    },
  );

  it.each(["cancel button", "tab close"] as const)(
    "cancels an active upload through %s without pasting late results",
    async (trigger) => {
      const controller = createTerminalController();
      createGhosttyTerminalMock.mockResolvedValue(controller);
      const pendingUpload = createDeferred<{ path: string; size: number }>();
      let uploadSignal: AbortSignal | undefined;
      const client = uploadClient((_params, signal) => {
        uploadSignal = signal;
        return pendingUpload.promise;
      });
      const panel = await mountReadyPanel(client);
      dropFiles(panel, [terminalUploadFile("archive.zip", "zip")]);
      await waitForFast(() => {
        expect(panel.querySelector(".tp-upload-card")?.textContent).toContain("Uploading 1 of 1");
      });

      panelButton(
        panel,
        trigger === "cancel button" ? ".tp-upload-cancel" : ".tabstrip-tab__close",
      )?.click();
      await panel.updateComplete;
      await waitForFast(() => {
        expect(uploadSignal?.aborted).toBe(true);
        expect(panel.querySelector(".tp-upload-card")).toBeNull();
      });
      if (trigger === "cancel button") {
        expect(panelButton(panel, ".tp-upload")?.disabled).toBe(false);
        pendingUpload.resolve({ path: "/tmp/openclaw upload/archive.zip", size: 3 });
      } else {
        pendingUpload.reject(new Error("terminal closed"));
      }
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.terminal.paste).not.toHaveBeenCalled();
      expect(panel.querySelector(".tp-upload-card")).toBeNull();
    },
  );
});
