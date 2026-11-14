import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { createDocumentTitle } from "./document-title.ts";

const originalTitle = document.title;
afterEach(() => {
  document.title = originalTitle;
});

it("updates the title and restores the original when its owner is disposed", () => {
  document.title = "OpenClaw";
  const [title, setTitle] = createSignal("Question pending");
  const dispose = createRoot((stop) => {
    createDocumentTitle(title);
    return stop;
  });
  onTestFinished(dispose);

  flush();
  expect(document.title).toBe("Question pending");
  setTitle("Question answered");
  flush();
  expect(document.title).toBe("Question answered");

  dispose();
  expect(document.title).toBe("OpenClaw");
  setTitle("Question expired");
  flush();
  expect(document.title).toBe("OpenClaw");
});

it("preserves another writer's title when its owner is disposed", () => {
  document.title = "OpenClaw";
  const dispose = createRoot((stop) => {
    createDocumentTitle(() => "Approval pending");
    return stop;
  });
  onTestFinished(dispose);
  flush();
  expect(document.title).toBe("Approval pending");

  document.title = "Chat";
  dispose();
  expect(document.title).toBe("Chat");
});

it("preserves another writer's title when disposed before the first effect runs", () => {
  document.title = "OpenClaw";
  createRoot((dispose) => {
    createDocumentTitle(() => "Question pending");
    document.title = "Chat";
    dispose();
  });

  flush();
  expect(document.title).toBe("Chat");
});
