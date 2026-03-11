import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ToolCard } from "../types/chat-types.ts";
import { renderToolCardSidebar } from "./tool-cards.ts";

describe("tool-cards sidebar", () => {
  it("shows full command plus output in sidebar while card detail remains truncated", () => {
    const longCommand = `python3 ~/.openclaw/workspace/skills/node-cluster-3.connector/scripts/main.py invoke wangjx-node-host system.run --raw-command '${"x".repeat(220)}'`;
    const onOpenSidebar = vi.fn();
    const card: ToolCard = {
      kind: "result",
      name: "exec",
      args: { command: longCommand, cwd: "/tmp/demo", timeoutMs: 5000 },
      text: "command output line 1\ncommand output line 2",
    };

    const container = document.createElement("div");
    render(renderToolCardSidebar(card, onOpenSidebar), container);

    const detail = container.querySelector(".chat-tool-card__detail");
    expect(detail?.textContent).toContain("…");

    const clickable = container.querySelector(".chat-tool-card") as HTMLElement;
    clickable.click();

    expect(onOpenSidebar).toHaveBeenCalledTimes(1);
    const content = onOpenSidebar.mock.calls[0][0] as string;
    expect(content).toContain(longCommand);
    expect(content).toContain('"cwd": "/tmp/demo"');
    expect(content).toContain("command output line 1");
    expect(content).toContain("**Command:**");
    expect(content).toContain("**Args:**");
  });

  it("shows full args and explicit no-output note when no command exists", () => {
    const onOpenSidebar = vi.fn();
    const card: ToolCard = {
      kind: "result",
      name: "read",
      args: { path: "/tmp/file.txt", offset: 10, limit: 5 },
    };

    const container = document.createElement("div");
    render(renderToolCardSidebar(card, onOpenSidebar), container);
    (container.querySelector(".chat-tool-card") as HTMLElement).click();

    const content = onOpenSidebar.mock.calls[0][0] as string;
    expect(content).toContain("**Args:**");
    expect(content).toContain('"path": "/tmp/file.txt"');
    expect(content).toContain("No output — tool completed successfully");
  });
});
