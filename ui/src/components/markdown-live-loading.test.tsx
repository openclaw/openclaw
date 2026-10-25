import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { ChatLazyBoundary } from "../pages/chat/components/chat-lazy-boundary.tsx";
import { MessageMarkdown } from "../pages/chat/components/chat-message-text-view.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";

const runtime = vi.hoisted(() => Promise.withResolvers<void>());
vi.mock("./markdown-live.ts", async (importOriginal) => {
  await runtime.promise;
  return importOriginal();
});

it("renders current safe Markdown and retains its DOM while the live runtime loads", async () => {
  const initial = "First paragraph\n\n**Growing";
  const [source, setSource] = createSignal(initial);
  const [streaming, setStreaming] = createSignal(true);
  const [finished, setFinished] = createSignal(false);
  const view = mountSolid(() => (
    <>
      <section class="final-history">
        <MessageMarkdown
          markdown="Settled **history**"
          messageKey="history"
          options={{ role: "assistant", isStreaming: false }}
          markdownOptions={{}}
        />
      </section>
      <section class="live-message">
        <ChatLazyBoundary fallback={<span>Loading reply</span>}>
          <MessageMarkdown
            markdown={source()}
            messageKey="live"
            options={{ role: "assistant", isStreaming: streaming() }}
            markdownOptions={{}}
          />
        </ChatLazyBoundary>
      </section>
      <section class="completed-message">
        <ChatLazyBoundary fallback={<span>Loading reply</span>}>
          <MessageMarkdown
            markdown={finished() ? "Completed **reply**" : "**Pending delta"}
            messageKey="completed"
            options={{ role: "assistant", isStreaming: !finished() }}
            markdownOptions={{}}
          />
        </ChatLazyBoundary>
      </section>
      <section class="live-code">
        <ChatLazyBoundary fallback={<span>Loading reply</span>}>
          <MessageMarkdown
            markdown="```text\nCopyable while loading"
            messageKey="code"
            options={{ role: "assistant", isStreaming: streaming() }}
            markdownOptions={{}}
          />
        </ChatLazyBoundary>
      </section>
    </>
  ));
  expect(view.container.querySelector(".final-history strong")?.textContent).toBe("history");
  await waitForSolid(() => {
    expect(view.container.querySelector(".live-message")?.textContent).toContain("Growing");
  });
  const paragraphs = [...view.container.querySelectorAll(".live-message p")];
  expect(paragraphs).toHaveLength(2);
  const expectRetainedParagraphs = () => {
    const current = view.container.querySelectorAll(".live-message p");
    expect(current).toHaveLength(paragraphs.length);
    current.forEach((paragraph, index) => expect(paragraph).toBe(paragraphs[index]));
  };
  const copy = view.container.querySelector(".live-code .code-block-copy");
  expect(copy).not.toBeNull();

  const latest = `${initial} delta**<img src="x" onerror="alert(1)">`;
  setSource(latest);
  setFinished(true);
  await waitForSolid(() => {
    expect(view.container.querySelector(".completed-message strong")?.textContent).toBe("reply");
    expect(view.container.querySelector(".live-message strong")?.textContent).toBe("Growing delta");
  });
  expectRetainedParagraphs();
  expect(view.container.querySelector("[onerror], script")).toBeNull();

  runtime.resolve();
  await vi.dynamicImportSettled();
  await waitForSolid(() => {
    expect(view.container.querySelector(".live-message strong")?.textContent).toBe("Growing delta");
  });
  expectRetainedParagraphs();
  expect(view.container.querySelector(".live-code .code-block-copy")).toBe(copy);
  setSource(`${latest} More`);
  await waitForSolid(() => {
    expect(view.container.querySelector(".live-message")?.textContent).toContain("More");
  });
  setStreaming(false);
  await waitForSolid(() => {
    expectRetainedParagraphs();
    expect(view.container.querySelector(".live-code .code-block-copy")).toBe(copy);
  });
  expect(view.container.querySelector(".completed-message")?.textContent).toBe("Completed reply\n");
  expect(view.container.querySelector("[onerror], script")).toBeNull();
});
