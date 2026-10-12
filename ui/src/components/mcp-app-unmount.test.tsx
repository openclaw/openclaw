import { createMemo, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { McpAppUnmountGate } from "./mcp-app-unmount.ts";

const targetTag = "mcp-app-view";
const teardown = vi.fn<() => Promise<void>>();

type TestMcpAppUnmountTarget = HTMLElement & { restartCalls: number };

function prepareTarget(element: Element | undefined) {
  if (element instanceof HTMLElement) {
    Object.assign(element, {
      restartCalls: 0,
      restartAfterTeardown() {
        this.restartCalls += 1;
      },
      // A registered App may also tear down on disconnect; the gate must act while connected.
      teardown: () => (element.isConnected ? teardown() : Promise.resolve()),
    });
  }
}

function mountGate(
  renderValue: () => Node[],
  leavingRoots: (root: HTMLElement) => Iterable<ParentNode> = (root) => [root],
) {
  const host = document.createElement("div");
  const shadowRoot = host.attachShadow({ mode: "open" });
  const root = document.createElement("div");
  shadowRoot.append(root);
  document.body.append(host);
  let key = "initial";
  let retainRenderedValue = false;
  let requestUpdate = () => {};
  const gate = new McpAppUnmountGate<Node[]>({ requestUpdate: () => requestUpdate() });
  mountSolid(
    () => {
      const [revision, setRevision] = createSignal(0, { ownedWrite: true });
      requestUpdate = () => setRevision((value) => value + 1);
      const value = createMemo(() => {
        revision();
        return gate.render(key, renderValue, () => leavingRoots(root), { retainRenderedValue });
      });
      return <>{value()}</>;
    },
    { container: root },
  );
  return {
    shadowRoot,
    get updateComplete() {
      return Promise.resolve().then(() => flush());
    },
    show(this: void, nextKey: string, retain = false) {
      key = nextKey;
      retainRenderedValue = retain;
      requestUpdate();
    },
  };
}

function valueSpan(value: string) {
  const span = document.createElement("span");
  span.dataset.value = value;
  span.textContent = value;
  return span;
}

function mountOwner() {
  const target = document.createElement(targetTag);
  prepareTarget(target);
  const initial = valueSpan("initial");
  let valueKey = "initial";
  const renderValue = vi.fn(() =>
    valueKey === "initial" ? [target, initial] : [valueSpan(valueKey)],
  );
  const owner = mountGate(renderValue);
  const show = owner.show;
  return Object.assign(owner, {
    renderValue,
    show(key: string, nextValueKey = key, retainRenderedValue = false) {
      valueKey = nextValueKey;
      show(key, retainRenderedValue);
    },
  });
}

function mountSiblingOwner() {
  const leaving = document.createElement("div");
  leaving.className = "leaving";
  const target = document.createElement(targetTag);
  prepareTarget(target);
  leaving.append(target);
  const retained = document.createElement(targetTag);
  retained.className = "retained";
  prepareTarget(retained);
  let includeLeaving = true;
  const owner = mountGate(
    () => (includeLeaving ? [leaving, retained] : [retained]),
    (root) => root.querySelectorAll(".leaving"),
  );
  return Object.assign(owner, {
    removeLeaving() {
      includeLeaving = false;
      owner.show("retained");
    },
  });
}

afterEach(() => {
  document.body.replaceChildren();
  teardown.mockReset();
});

describe("McpAppUnmountGate", () => {
  it("retains the current value for an unchanged explicit owner", async () => {
    const owner = mountOwner();
    await owner.updateComplete;
    const target = owner.shadowRoot!.querySelector(targetTag);

    owner.show("initial", "pending", true);
    await owner.updateComplete;
    expect(owner.shadowRoot!.querySelector(targetTag)).toBe(target);
    expect(owner.shadowRoot!.querySelector("[data-value='pending']")).toBeNull();
    expect(teardown).not.toHaveBeenCalled();

    owner.show("initial", "resolved");
    await owner.updateComplete;
    expect(owner.shadowRoot!.querySelector(targetTag)).toBeNull();
    expect(owner.shadowRoot!.querySelector("[data-value='resolved']")).not.toBeNull();
  });

  it("keeps the old subtree connected and coalesces replacements until teardown resolves", async () => {
    const pending = createDeferred();
    teardown.mockReturnValue(pending.promise);
    const owner = mountOwner();
    await owner.updateComplete;
    owner.renderValue.mockClear();

    const target = owner.shadowRoot!.querySelector(targetTag)!;
    owner.show("intermediate");
    await owner.updateComplete;
    expect(teardown).toHaveBeenCalledOnce();
    expect(owner.renderValue).not.toHaveBeenCalled();
    expect(target.isConnected).toBe(true);
    expect(owner.shadowRoot!.querySelector("[data-value='initial']")).not.toBeNull();

    owner.show("latest");
    await owner.updateComplete;
    expect(teardown).toHaveBeenCalledOnce();
    expect(owner.renderValue).not.toHaveBeenCalled();
    expect(owner.shadowRoot!.querySelector("[data-value='latest']")).toBeNull();

    pending.resolve();
    await expect
      .poll(() => owner.shadowRoot!.querySelector("[data-value='latest']"))
      .not.toBeNull();
    expect(owner.renderValue).toHaveBeenCalledOnce();
    expect(owner.shadowRoot!.querySelector(targetTag)).toBeNull();
    expect(owner.shadowRoot!.querySelector("[data-value='intermediate']")).toBeNull();
  });

  it("restarts the original target when a pending transition rebounds", async () => {
    const pending = createDeferred();
    teardown.mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const owner = mountOwner();
    await owner.updateComplete;
    const original = owner.shadowRoot!.querySelector<TestMcpAppUnmountTarget>(targetTag)!;

    owner.show("intermediate");
    await owner.updateComplete;
    owner.show("initial");
    await owner.updateComplete;
    expect(original.isConnected).toBe(true);

    pending.resolve();
    await expect.poll(() => original.restartCalls).toBe(1);
    expect(owner.shadowRoot!.querySelector(targetTag)).toBe(original);
    expect(teardown).toHaveBeenCalledOnce();
  });

  it("preserves retained siblings while removing a torn-down target", async () => {
    const pending = createDeferred();
    teardown.mockReturnValue(pending.promise);
    const owner = mountSiblingOwner();
    await owner.updateComplete;
    const leaving = owner.shadowRoot!.querySelector<TestMcpAppUnmountTarget>(
      `.leaving ${targetTag}`,
    )!;
    const retained = owner.shadowRoot!.querySelector<TestMcpAppUnmountTarget>(".retained")!;

    owner.removeLeaving();
    await owner.updateComplete;
    expect(leaving.isConnected).toBe(true);
    expect(retained.isConnected).toBe(true);

    pending.resolve();
    await expect.poll(() => owner.shadowRoot!.querySelector(".leaving")).toBeNull();
    expect(owner.shadowRoot!.querySelector(".retained")).toBe(retained);
    expect(retained.restartCalls).toBe(0);
    expect(teardown).toHaveBeenCalledOnce();
  });
});
