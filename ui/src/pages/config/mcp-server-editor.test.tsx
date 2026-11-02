/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerSummary } from "../../lib/config/mcp-servers.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { McpServerEditor } from "./mcp-server-editor.tsx";
import type { ConfigProps } from "./view-types.ts";

const schema = {
  type: "object",
  properties: {
    mcp: {
      type: "object",
      properties: {
        servers: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              command: { type: "string" },
              args: { type: "array", items: { type: "string" } },
              url: { type: "string" },
              auth: { type: "string", const: "oauth" },
            },
          },
        },
      },
    },
  },
};

function summary(name: string, transport: McpServerSummary["transport"]): McpServerSummary {
  return {
    name,
    enabled: true,
    transport,
    target: "",
    auth: null,
    signIn: null,
    toolFilter: false,
    parallel: false,
    tls: null,
  };
}

function mountEditor(servers: Record<string, unknown>, server: McpServerSummary) {
  const onFormPatch = vi.fn(() => true);
  const onFormRemove = vi.fn(() => true);
  const onRenamed = vi.fn();
  const config = {
    schema,
    uiHints: {},
    formValue: { mcp: { servers } },
    onFormPatch,
    onFormRemove,
    viewState: {},
    onViewStateChange: () => undefined,
    onAppearanceChange: () => undefined,
  } as unknown as ConfigProps;
  const { container } = mountSolid(() => (
    <McpServerEditor config={config} server={server} onRenamed={onRenamed} />
  ));
  flush();
  return { container, onFormPatch, onFormRemove, onRenamed };
}

function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
  flush();
}

afterEach(() => cleanupSolid());

describe("McpServerEditor", () => {
  it("edits arguments as lines and keeps spaces inside one argument", () => {
    const { container, onFormPatch, onFormRemove } = mountEditor(
      { local: { command: "npx", args: ["--stdio", "/My Files/a b.json"] } },
      summary("local", "stdio"),
    );
    const args = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')!;
    expect(args.value).toBe("--stdio\n/My Files/a b.json");
    change(args, " --stdio \n\n/My Files/c d.json\n");
    expect(onFormPatch).toHaveBeenCalledWith(
      ["mcp", "servers", "local", "args"],
      ["--stdio", "/My Files/c d.json"],
    );
    change(args, "  ");
    expect(onFormRemove).toHaveBeenCalledWith(["mcp", "servers", "local", "args"]);
  });

  it("never saves a stdio server without a command", () => {
    const { container, onFormPatch } = mountEditor(
      { local: { command: "npx" } },
      summary("local", "stdio"),
    );
    const command = container.querySelector<HTMLInputElement>('input[aria-label="Command"]')!;
    change(command, "   ");
    expect(onFormPatch).not.toHaveBeenCalled();
    expect(command.value).toBe("npx");
    change(command, "uvx");
    expect(onFormPatch).toHaveBeenCalledWith(["mcp", "servers", "local", "command"], "uvx");
  });

  it("renames by moving the entry and reports the new name", () => {
    const { container, onFormPatch, onRenamed } = mountEditor(
      { docs: { url: "https://mcp.test" }, other: { url: "https://other.test" } },
      summary("docs", "streamable-http"),
    );
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    change(name, "renamed");
    expect(onFormPatch).toHaveBeenCalledWith(["mcp", "servers"], {
      other: { url: "https://other.test" },
      renamed: { url: "https://mcp.test" },
    });
    expect(onRenamed).toHaveBeenCalledWith("renamed");
  });

  it.each([
    ["other", "already exists"],
    ["bad name!", "letters, numbers"],
  ])("refuses the name %s and restores the field", (next, reason) => {
    const { container, onFormPatch } = mountEditor(
      { docs: { url: "https://mcp.test" }, other: { url: "https://other.test" } },
      summary("docs", "streamable-http"),
    );
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    change(name, next);
    expect(onFormPatch).not.toHaveBeenCalled();
    expect(name.value).toBe("docs");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(reason);
  });

  it("does not carry a redacted credential to a new name", () => {
    const { container, onFormPatch } = mountEditor(
      { docs: { url: "https://mcp.test", headers: { Authorization: "__OPENCLAW_REDACTED__" } } },
      summary("docs", "streamable-http"),
    );
    change(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, "renamed");
    expect(onFormPatch).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("writes OAuth as the literal the config expects", () => {
    const { container, onFormPatch } = mountEditor(
      { docs: { url: "https://mcp.test" } },
      summary("docs", "streamable-http"),
    );
    const oauth = [...container.querySelectorAll<HTMLInputElement>('input[role="switch"]')][0]!;
    expect(oauth.checked).toBe(false);
    oauth.click();
    flush();
    expect(onFormPatch).toHaveBeenCalledWith(["mcp", "servers", "docs", "auth"], "oauth");
  });
});
