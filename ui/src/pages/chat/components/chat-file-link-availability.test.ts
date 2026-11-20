/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { markdownFileLinkFromEvent } from "../../../components/markdown-file-links.ts";
import {
  observeFileLinkAvailability,
  type FileLinkStat,
  type FileLinkStatRequest,
} from "./chat-file-link-availability.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((stop) => stop());
  document.body.replaceChildren();
});

function fileLink(path: string) {
  const anchor = document.createElement("a");
  anchor.className = "markdown-file-link";
  anchor.dataset.filePath = path;
  anchor.setAttribute("role", "button");
  anchor.setAttribute("tabindex", "0");
  anchor.textContent = path.split("/").at(-1) ?? path;
  return anchor;
}

function message(entryId: string, ...paths: string[]) {
  const element = document.createElement("div");
  element.dataset.entryId = entryId;
  element.append(...paths.map(fileLink));
  return element;
}

function statFrom(missing: ReadonlySet<string>) {
  const requests: FileLinkStatRequest[] = [];
  const stat = vi.fn<FileLinkStat>(async (request) => {
    requests.push(request);
    return {
      sessionKey: request.sessionKey ?? "agent:main:main",
      files: request.files.map((file) => ({
        path: file.path,
        status: missing.has(file.path) ? ("missing" as const) : ("file" as const),
      })),
    };
  });
  return { stat, requests };
}

const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
const unavailable = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLAnchorElement>("a[data-file-unavailable]")].map(
    (anchor) => anchor.dataset.filePath,
  );

function observe(root: HTMLElement, stat: FileLinkStat, sessionKey = "agent:main:main") {
  cleanup.push(observeFileLinkAvailability(root, stat, () => sessionKey));
}

it("demotes links the Gateway cannot open and keeps the rest clickable", async () => {
  const root = document.createElement("div");
  root.append(message("e1", "~/crabbox-work/reset-profile.sh", "src/app.ts"));
  document.body.append(root);
  const { stat, requests } = statFrom(new Set(["~/crabbox-work/reset-profile.sh"]));

  observe(root, stat);
  await settle();

  expect(requests).toEqual([
    {
      files: [
        { path: "~/crabbox-work/reset-profile.sh", messageEntryId: "e1" },
        { path: "src/app.ts", messageEntryId: "e1" },
      ],
    },
  ]);
  expect(unavailable(root)).toEqual(["~/crabbox-work/reset-profile.sh"]);
  const [missing, present] = root.querySelectorAll<HTMLAnchorElement>("a");
  expect(missing?.hasAttribute("role")).toBe(false);
  expect(missing?.hasAttribute("tabindex")).toBe(false);
  expect(present?.getAttribute("role")).toBe("button");

  const click = (anchor: HTMLAnchorElement) => {
    const event = new MouseEvent("click", { bubbles: true });
    anchor.dispatchEvent(event);
    return markdownFileLinkFromEvent(
      Object.defineProperty(event, "target", { value: anchor }) as Event,
    );
  };
  expect(click(missing!)).toBeNull();
  expect(click(present!)).toMatchObject({ path: "src/app.ts", messageEntryId: "e1" });
});

it("waits for streaming to end, then reuses answers for re-rendered links", async () => {
  const root = document.createElement("div");
  const streaming = message("e2", "notes/plan.md");
  streaming.dataset.chatStreaming = "true";
  root.append(streaming);
  document.body.append(root);
  const { stat } = statFrom(new Set(["notes/plan.md"]));

  observe(root, stat);
  await settle();
  expect(stat).not.toHaveBeenCalled();

  streaming.removeAttribute("data-chat-streaming");
  await settle();
  expect(stat).toHaveBeenCalledTimes(1);
  expect(unavailable(root)).toEqual(["notes/plan.md"]);

  streaming.replaceChildren(fileLink("notes/plan.md"));
  await settle();
  expect(stat).toHaveBeenCalledTimes(1);
  expect(unavailable(root)).toEqual(["notes/plan.md"]);
});

it("leaves links alone and asks again when the Gateway cannot answer", async () => {
  const root = document.createElement("div");
  root.append(message("e3", "src/a.ts"));
  document.body.append(root);
  const stat = vi.fn<FileLinkStat>(async () => null);

  observe(root, stat);
  await settle();
  expect(unavailable(root)).toEqual([]);

  root.append(message("e3", "src/a.ts"));
  await settle();
  expect(stat).toHaveBeenCalledTimes(2);
  expect(unavailable(root)).toEqual([]);
});

it("batches messages by owning session and splits large batches", async () => {
  const root = document.createElement("div");
  const paths = Array.from({ length: 70 }, (_, index) => `src/file-${index}.ts`);
  const subagent = message("e4", "src/shared.ts");
  subagent.dataset.fileSessionKey = "agent:main:subagent:child";
  root.append(message("e5", ...paths.slice(0, 40)), message("e6", ...paths.slice(40)), subagent);
  document.body.append(root);
  const { stat, requests } = statFrom(new Set(["src/shared.ts"]));

  observe(root, stat);
  await settle();

  expect(requests.map((request) => request.files.length)).toEqual([64, 6, 1]);
  expect(requests[0]?.files[39]).toEqual({ path: "src/file-39.ts", messageEntryId: "e5" });
  expect(requests[0]?.files[40]).toEqual({ path: "src/file-40.ts", messageEntryId: "e6" });
  expect(requests[2]).toEqual({
    sessionKey: "agent:main:subagent:child",
    files: [{ path: "src/shared.ts" }],
  });
  expect(unavailable(root)).toEqual(["src/shared.ts"]);
});

it("ignores answers that do not line up with the request", async () => {
  const root = document.createElement("div");
  root.append(message("e7", "src/a.ts", "src/b.ts"));
  document.body.append(root);
  const stat = vi.fn<FileLinkStat>(async (request) => ({
    sessionKey: "agent:main:main",
    files: request.files
      .toReversed()
      .map((file) => ({ path: file.path, status: "missing" as const })),
  }));

  observe(root, stat);
  await settle();

  expect(unavailable(root)).toEqual([]);
});
