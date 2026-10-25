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

it("keeps final history synchronous and renders only the latest safe delta after loading", async () => {
  const [source, setSource] = createSignal("**First delta");
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
            options={{ role: "assistant", isStreaming: true }}
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
    </>
  ));
  expect(view.container.querySelector(".final-history strong")?.textContent).toBe("history");
  await waitForSolid(() => {
    expect(view.container.querySelector(".live-message")?.textContent).toBe("Loading reply");
  });

  setSource('**Latest delta**<img src="x" onerror="alert(1)">');
  setFinished(true);
  await waitForSolid(() => {
    expect(view.container.querySelector(".completed-message strong")?.textContent).toBe("reply");
  });
  expect(view.container.querySelector(".live-message")?.textContent).not.toContain("Latest");

  runtime.resolve();
  await waitForSolid(() => {
    expect(view.container.querySelector(".live-message strong")?.textContent).toBe("Latest delta");
  });
  expect(view.container.querySelector(".live-message")?.textContent).not.toContain("First");
  expect(view.container.querySelector(".completed-message")?.textContent).toBe("Completed reply\n");
  expect(view.container.querySelector("[onerror], script")).toBeNull();
});
