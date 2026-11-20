/* @vitest-environment jsdom */
import type { SystemChangesListResult } from "@openclaw/gateway-protocol";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { SystemHistoryPage } from "./system-history-page.tsx";
import { createContext } from "./test-support.ts";
const methods = ["openclaw.changes.list", "openclaw.chat.history"];
const entry = {
  id: "change",
  at: 1700000000000,
  kind: "config-write" as const,
  source: "config-rpc" as const,
  summary: "Changed plugin settings",
  changedPaths: ["plugins.entries.example.enabled"],
};
function mount(harness: ReturnType<typeof createContext>) {
  return mountSolid(() => <SystemHistoryPage />, {
    wrapper: createSolidApplicationContextProvider(harness.context).wrapper,
  });
}
it("keeps expanded changes through a rejected page read and retries without starting an assistant", async () => {
  const more = createDeferred<SystemChangesListResult>();
  const reads = vi
    .fn()
    .mockResolvedValueOnce({ entries: [entry], nextCursor: "next" })
    .mockReturnValueOnce(more.promise)
    .mockResolvedValueOnce({ entries: [{ ...entry, summary: "Read recovered" }] });
  const request = vi.fn((method: string) =>
    method === "openclaw.changes.list"
      ? reads()
      : Promise.resolve({
          turns: [{ role: "assistant", text: "Earlier setup", at: 1700000000000 }],
        }),
  );
  const view = mount(createContext(request, methods));
  await waitForSolid(() => expect(view.container.textContent).toContain(entry.summary));
  const details = view.container.querySelector<HTMLDetailsElement>(
    ".system-history__change-paths",
  )!;
  details.open = true;
  view.container.querySelector<HTMLButtonElement>(".system-history__history-more")!.click();
  more.reject(new Error("Read interrupted"));
  await waitForSolid(() => expect(view.container.textContent).toContain("Read interrupted"));
  expect(details.open).toBe(true);
  expect(view.container.querySelector(".system-history__change-paths")).toBe(details);
  view.container.querySelector<HTMLButtonElement>(".system-history__history-error button")!.click();
  await waitForSolid(() => expect(view.container.textContent).toContain("Read recovered"));
  expect(request.mock.calls.every(([method]) => methods.includes(method))).toBe(true);
});
it("hides old machine history and issues no reads when the same connection becomes a restricted viewer", async () => {
  const request = vi.fn((method: string) =>
    Promise.resolve(method === methods[0] ? { entries: [entry] } : { turns: [] }),
  );
  const harness = createContext(request, methods);
  const view = mount(harness);
  await waitForSolid(() => expect(view.container.textContent).toContain(entry.summary));
  const hello = harness.context.gateway.snapshot.hello!;
  request.mockClear();
  harness.setGatewaySnapshot({
    selfUser: { id: "reader", name: "Reader" },
    hello: { ...hello, auth: { role: "operator", scopes: ["operator.read"] } },
  });
  await waitForSolid(() => expect(view.container.textContent).toContain("administrator access"));
  expect(view.container.textContent).not.toContain(entry.summary);
  expect(request).not.toHaveBeenCalled();
});
