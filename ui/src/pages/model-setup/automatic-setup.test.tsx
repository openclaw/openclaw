/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { projectCallbackOwner } from "../../lib/reactive/callback-owner.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { AutomaticSetupCard } from "./automatic-setup-card.tsx";
import { AutomaticModelSetup, type SetupAutoResult } from "./automatic-setup.ts";
import {
  createFirstRunContext,
  detection,
  useFirstRunFixtures,
} from "./model-setup-first-run.test-support.ts";
import { createPage, mountModelSetupPage } from "./test-helpers/solid-page.test-support.tsx";

useFirstRunFixtures("automatic-setup-fixture");
const selected = {
  kind: "codex-cli",
  label: "ChatGPT",
  modelRef: "openai/model",
  detail: "Available",
};
const alternative = {
  kind: "ollama",
  label: "Local model",
  modelRef: "ollama/model",
  detail: "Available",
};
const firstAgent = { agentId: "main", sessionKey: "agent:main:main", bootstrapPending: true };
const ready: SetupAutoResult = {
  status: "configured",
  selected,
  alternatives: [alternative],
  attempts: [],
  installedPlugins: [],
  firstAgent,
};
const disposals: (() => void)[] = [];
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose());
  delete window["__OPENCLAW_NATIVE_SETUP__"];
});

function mount(automatic: () => Promise<SetupAutoResult> = async () => ready) {
  const fixture = createFirstRunContext();
  fixture.snapshot.hello.features.methods = [
    ...fixture.snapshot.hello.features.methods,
    "openclaw.setup.auto",
    "openclaw.setup.auth.start",
  ];
  Object.assign(fixture.context, {
    agents: { ...fixture.context.agents, refreshList: vi.fn(async () => null) },
  });
  Object.assign(fixture.context.agentSelection, { set: vi.fn() });
  Object.assign(fixture.context.gateway, { setSessionKey: vi.fn() });
  fixture.request.mockImplementation(async (method) => {
    if (method === "openclaw.setup.auto") {
      return await automatic();
    }
    throw new Error("Unexpected request: " + method);
  });
  let owner!: AutomaticModelSetup;
  const rendered = mountSolid(
    () => {
      const projection = projectCallbackOwner(
        (changed) => new AutomaticModelSetup(changed),
        (setup) => setup,
      );
      owner = projection.owner;
      return <AutomaticSetupCard owner={owner} revision={projection.view.revision} />;
    },
    { wrapper: createSolidApplicationContextProvider(fixture.context).wrapper },
  );
  flush();
  owner.synchronize(fixture.context, true, "fixture-owner");
  disposals.push(() => {
    owner.dispose();
    rendered.unmount();
  });
  return { ...fixture, owner, page: rendered.container };
}
function button(page: HTMLElement, name: string) {
  const found = [...page.querySelectorAll("button")].find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === name,
  );
  expect(found, name).toBeDefined();
  return found!;
}

it.each([true, false])(
  "retains the current model while an alternative settles (success=%s)",
  async (ok) => {
    const initial = createDeferred<SetupAutoResult>();
    const activation = createDeferred<unknown>();
    const { page, owner, request } = mount(() => initial.promise);
    await waitForSolid(() => expect(page.textContent).toContain("Connecting your AI"));
    initial.resolve(ready);
    await waitForSolid(() => expect(page.textContent).toContain("Using ChatGPT"));
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.activate") {
        return await activation.promise;
      }
      throw new Error(method);
    });
    button(page, "Local model").click();
    button(page, "Local model").click();
    await waitForSolid(() => expect(button(page, "Local model").disabled).toBe(true));
    expect(owner.result?.selected).toEqual(selected);
    expect(
      request.mock.calls.filter(([method]) => method === "openclaw.setup.activate"),
    ).toHaveLength(1);
    activation.resolve(
      ok
        ? { ok: true, modelRef: alternative.modelRef, firstAgent }
        : { ok: false, error: "Model offline" },
    );
    await waitForSolid(() =>
      expect(page.textContent).toContain(ok ? "Using Local model" : "Model offline"),
    );
    expect(owner.result?.selected?.modelRef).toBe(ok ? alternative.modelRef : selected.modelRef);
  },
);

it("offers the ordinary Home draft without sending a chat turn", async () => {
  const { context, request, snapshot } = createFirstRunContext();
  snapshot.hello.features.methods = [...snapshot.hello.features.methods, "openclaw.setup.auto"];
  Object.assign(context.agents, { refreshList: vi.fn(async () => null) });
  request.mockImplementation(async (method) => {
    if (method === "openclaw.setup.auto") {
      return ready;
    }
    if (method === "openclaw.setup.detect") {
      return detection;
    }
    throw new Error("Unexpected request: " + method);
  });
  const page = createPage(context);
  page.routeData = { firstRun: true, automatic: true };
  document.body.append(page);
  mountModelSetupPage(page);
  await waitForSolid(() => expect(page.textContent).toContain("Start talking to your agent"));
  button(page, "Start talking to your agent").click();
  expect(context.navigate).toHaveBeenCalledWith(
    "chat",
    expect.objectContaining({
      pathname: "/openclaw/chat/main",
      search: "?draft=Wake%20up%2C%20my%20friend!",
    }),
  );
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "openclaw.setup.auto",
    "openclaw.setup.detect",
  ]);
});

it.each([false, true])(
  "refreshes sign-in and keeps cancellation available (shared=%s)",
  async (shared) => {
    const signIn = { authOptionId: "fixture-sign-in", label: "ChatGPT" };
    let calls = 0;
    const { page, request } = mount(async () =>
      ++calls > 1
        ? ready
        : {
            ...ready,
            status: shared ? "configured" : "needs-sign-in",
            firstAgent: undefined,
            selected: shared ? { ...selected, shared: true } : undefined,
            ...(shared ? { separateSignIn: signIn } : { signIn }),
          },
    );
    const answer = createDeferred<unknown>();
    const cancellation = createDeferred<unknown>();
    request.mockImplementation(async (method, params) => {
      if (method === "openclaw.setup.auto") {
        calls += 1;
        return ready;
      }
      if (method === "openclaw.setup.auth.start") {
        return { done: false };
      }
      if (method === "wizard.cancel") {
        return await cancellation.promise;
      }
      if (method === "wizard.next") {
        return params && typeof params === "object" && "answer" in params
          ? await answer.promise
          : { done: false, step: { id: "confirm", type: "confirm", message: "Continue?" } };
      }
      throw new Error(method);
    });
    await waitForSolid(() =>
      expect(page.textContent).toContain(shared ? "Sign in separately" : "Sign in with ChatGPT"),
    );
    button(page, shared ? "Sign in separately" : "Sign in with ChatGPT").click();
    await waitForSolid(() => expect(page.textContent).toContain("Continue?"));
    button(page, "Yes").click();
    await waitForSolid(() => expect(button(page, "Yes").disabled).toBe(true));
    expect(button(page, "Cancel").disabled).toBe(false);
    button(page, "Cancel").click();
    await waitForSolid(() => expect(button(page, "Cancel").disabled).toBe(true));
    cancellation.resolve({ status: "running" });
    await waitForSolid(() => expect(button(page, "Cancel").disabled).toBe(false));
    answer.resolve({ done: true, status: "done" });
    await waitForSolid(() => expect(page.textContent).toContain("Start talking to your agent"));
    expect(calls).toBe(2);
  },
);

it("discards a retired Gateway's result and keeps native recovery controls", async () => {
  const pending = createDeferred<SetupAutoResult>();
  const native = { openAiSetup: vi.fn(), openGateways: vi.fn(), reviewPermissions: vi.fn() };
  window["__OPENCLAW_NATIVE_SETUP__"] = native;
  const { page, owner, context, request } = mount(() => pending.promise);
  request.mockResolvedValue({
    status: "unavailable",
    alternatives: [],
    attempts: [],
    installedPlugins: [],
  });
  owner.synchronize(context, true, "replacement-owner");
  await waitForSolid(() => expect(page.textContent).toContain("Open AI setup"));
  pending.resolve(ready);
  await pending.promise;
  await waitForSolid(() => expect(page.textContent).not.toContain("Using ChatGPT"));
  button(page, "Open AI setup").click();
  button(page, "Use a different Gateway").click();
  button(page, "Review permissions").click();
  expect(native.openAiSetup).toHaveBeenCalledOnce();
  expect(native.openGateways).toHaveBeenCalledOnce();
  expect(native.reviewPermissions).toHaveBeenCalledOnce();
});
