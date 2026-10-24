import { createComponent, createSignal, flush } from "solid-js";
import { describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { resolveCheckoutChip } from "./checkout-chip.ts";
import { CheckoutChip } from "./checkout-chip.tsx";
import type { DraftRepositoryState } from "./discovery.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import type { DraftRepositoryRead } from "./draft-repository-state.ts";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";

type CheckoutFixture = {
  state: ReturnType<typeof resolveCheckoutChip>;
  remotePlacement: boolean;
  currentCheckoutUnavailableReason?: string;
  repository?: boolean;
  folderLabel: string;
  worktree: boolean;
  worktreeAvailable: boolean;
  repositoryUnavailable?: boolean;
  branches: Omit<Extract<DraftRepositoryState, { kind: "git" }>, "kind"> | null;
  branchesLoading: boolean;
  repositoryRead?: DraftRepositoryRead<unknown>;
  checkoutRead?: DraftRepositoryRead<unknown>;
  baseRef: string;
  worktreeName: string;
  submitting: boolean;
  pendingPlacement: boolean;
  popoverOpen: boolean;
  onPopoverShow: Mock<() => void>;
  onPopoverHide: Mock<() => void>;
  onPopoverAfterHide: Mock<() => void>;
  onSelectWorktree: Mock<(value: boolean) => void>;
  onBaseRefInput: Mock<(baseRef: string) => void>;
  onWorktreeNameInput: Mock<(name: string) => void>;
  onConfirm: Mock<() => void>;
};

function keydown(element: Element, key: string) {
  return element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function input(element: HTMLInputElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function afterHide(container: Element) {
  container
    .querySelector(".new-session-page__checkout-popover")!
    .dispatchEvent(new CustomEvent("overlay-after-hide"));
}

function waitForOpen(container: Element) {
  return waitForSolid(
    () => {
      expect(
        container.querySelector(".new-session-page__checkout-popover")?.getAttribute("data-phase"),
      ).toBe("open");
      expect(container.querySelector(".new-session-page__picker-root")).not.toBeNull();
    },
    { timeout: 5000 },
  );
}

function checkoutFixture(overrides: Partial<CheckoutFixture> = {}): CheckoutFixture {
  return {
    state: { label: "New worktree from main" },
    remotePlacement: false,
    folderLabel: "OpenClaw",
    worktree: true,
    worktreeAvailable: true,
    branches: {
      repoRoot: "/repo",
      branches: [{ name: "main", kind: "local" }],
      headBranch: "main",
    },
    branchesLoading: false,
    baseRef: "main",
    worktreeName: "",
    submitting: false,
    pendingPlacement: false,
    popoverOpen: true,
    onPopoverShow: vi.fn(),
    onPopoverHide: vi.fn(),
    onPopoverAfterHide: vi.fn(),
    onSelectWorktree: vi.fn(),
    onBaseRefInput: vi.fn(),
    onWorktreeNameInput: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
}

function mountCheckout(initial: CheckoutFixture) {
  const [params, setParams] = createSignal(initial);
  const { state: place, browser, gateway } = createRepositoryFixture();
  Object.defineProperties(place, {
    worktree: { get: () => params().worktree },
    worktreeName: { get: () => params().worktreeName },
    baseRef: { get: () => params().baseRef },
    remotePlacement: { get: () => params().remotePlacement },
    remoteRepository: {
      get: () => (params().repository ? { url: "https://example.com/repo.git" } : undefined),
    },
    currentCheckoutUnavailableReason: { get: () => params().currentCheckoutUnavailableReason },
    repositoryState: {
      get: () => ({ repositoryRead: params().repositoryRead, checkoutRead: params().checkoutRead }),
    },
    repository: {
      get: () => {
        const current = params();
        return current.branches
          ? { kind: "git", ...current.branches }
          : {
              kind: current.branchesLoading
                ? "checking"
                : current.repositoryUnavailable
                  ? "unavailable"
                  : "idle",
            };
      },
    },
  });
  vi.spyOn(place, "worktreeAvailable").mockImplementation(() => params().worktreeAvailable);
  vi.spyOn(place, "selectWorktree").mockImplementation((value) => params().onSelectWorktree(value));
  vi.spyOn(place, "setBaseRef").mockImplementation((value) => params().onBaseRefInput(value));
  vi.spyOn(place, "setWorktreeName").mockImplementation((value) =>
    params().onWorktreeNameInput(value),
  );
  vi.spyOn(browser, "popoverOpen").mockImplementation(() => params().popoverOpen);
  vi.spyOn(browser, "popoverCallbacks").mockImplementation(() => params());
  const options: NewSessionPlaceControlsOptions = {
    place,
    gateway,
    context: undefined,
    data: undefined,
    get submitting() {
      return params().submitting;
    },
    get pendingPlacement() {
      return params().pendingPlacement;
    },
    onConnectMachine: vi.fn(),
    onNavigate: vi.fn(),
    onChange: vi.fn(),
    onFocusComposer: () => params().onConfirm(),
  };
  const mounted = mountSolid(() =>
    createComponent(CheckoutChip, {
      params: options,
      get state() {
        return params().state;
      },
      get folderLabel() {
        return params().folderLabel;
      },
    }),
  );
  return {
    container: mounted.container,
    update: (next: CheckoutFixture) => {
      setParams(next);
      flush();
    },
  };
}

describe("Checkout chip state", () => {
  it.each([
    ["cloud", false, true, "main", undefined, "", "From main"],
    ["cloud", true, false, "", undefined, "", "Starting branch"],
    ["remote", true, false, "main", undefined, "x", "Remote checkout from main"],
    ["remote", true, false, "", undefined, "", "Remote checkout"],
    ["local", false, false, "main", "feature", "x", "feature"],
    ["local", false, false, "main", undefined, "", "Current checkout"],
    ["local", false, true, "main", "feature", "   ", "New worktree from main"],
    ["local", false, true, "", undefined, "", "New worktree"],
    ["local", false, true, "main", undefined, " x ", "Worktree · x"],
    ["cloud", true, true, "main", undefined, "x", "From main"],
  ] as const)(
    "%s repository=%s worktree=%s base=%s head=%s name=%s: %s",
    (destination, repository, worktree, baseRef, headBranch, worktreeName, label) => {
      expect(
        resolveCheckoutChip({
          destination,
          repository,
          worktree,
          baseRef,
          headBranch,
          worktreeName,
        }),
      ).toEqual({ label });
    },
  );

  it.each([
    { worktree: false, remotePlacement: false, repository: false },
    { worktree: true, remotePlacement: false, repository: false },
    {
      worktree: true,
      remotePlacement: false,
      repository: false,
      currentCheckoutUnavailableReason: "Use an isolated worktree for this project and agent",
    },
    { worktree: true, remotePlacement: true, repository: false },
    { worktree: false, remotePlacement: true, repository: true },
    { worktree: false, remotePlacement: true, repository: true, emptyBranches: true },
  ])(
    "offers explicit checkout choices (worktree=$worktree, remote=$remotePlacement, emptyBranches=$emptyBranches)",
    async ({
      worktree,
      remotePlacement,
      repository,
      emptyBranches,
      currentCheckoutUnavailableReason,
    }) => {
      const params = checkoutFixture({
        state: { label: worktree ? "New worktree from main" : "feature" },
        remotePlacement,
        currentCheckoutUnavailableReason,
        repository,
        worktree,
        branches: {
          repoRoot: "/repo",
          branches: emptyBranches
            ? []
            : [
                { name: "main", kind: "local" },
                { name: "release/next", kind: "local" },
              ],
          headBranch: "feature",
        },
      });
      const { onSelectWorktree, onBaseRefInput, onConfirm } = params;
      const { container } = mountCheckout(params);

      await waitForOpen(container);

      if (worktree || repository) {
        const baseRef = container.querySelector("input")!;
        if (emptyBranches) {
          expect(baseRef.hasAttribute("role")).toBe(false);
          expect(baseRef.hasAttribute("aria-expanded")).toBe(false);
          expect(container.querySelector('[role="listbox"]')).toBeNull();
        } else {
          expect(baseRef.getAttribute("role")).toBe("combobox");
          expect(container.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe(
            "From",
          );
        }
      }

      if (repository) {
        expect(container.querySelector('[data-value="checkout"]')).toBeNull();
        expect(container.querySelector('[data-value="worktree"]')).toBeNull();
        const inputs = container.querySelectorAll<HTMLInputElement>("input");
        expect(inputs).toHaveLength(1);
        input(inputs[0]!, "release/next");
        expect(onBaseRefInput).toHaveBeenCalledWith("release/next");
        keydown(inputs[0]!, "Enter");
        afterHide(container);
        expect(onConfirm).toHaveBeenCalledOnce();
        expect(container.textContent).toContain(
          "Clones OpenClaw on the selected runner. No Gateway checkout is created.",
        );
        return;
      }

      const current = container.querySelector<HTMLButtonElement>('[data-value="checkout"]')!;
      const isolated = container.querySelector<HTMLButtonElement>('[data-value="worktree"]')!;
      expect(current.getAttribute("aria-pressed")).toBe(String(!worktree));
      expect(current.disabled).toBe(remotePlacement || Boolean(currentCheckoutUnavailableReason));
      expect(current.getAttribute("title")).toBe(
        remotePlacement
          ? "Devices and cloud run in a worktree"
          : (currentCheckoutUnavailableReason ?? null),
      );
      expect(isolated.getAttribute("aria-pressed")).toBe(String(worktree));
      expect(isolated.disabled).toBe(false);
      current.click();
      isolated.click();
      expect(onSelectWorktree.mock.calls).toEqual(
        remotePlacement || currentCheckoutUnavailableReason ? [[true]] : [[false], [true]],
      );

      expect(container.querySelectorAll("input")).toHaveLength(worktree ? 2 : 0);
      expect(container.textContent?.includes("Syncs OpenClaw to the selected runner")).toBe(
        remotePlacement,
      );
    },
  );

  it("preserves editable fields through repository discovery failure and retry", async () => {
    const initial = createDeferred();
    const initialRead = { completed: initial.promise };
    const params = checkoutFixture({
      state: { label: "New worktree" },
      folderLabel: "Fixture project",
      worktreeAvailable: false,
      branches: null,
      branchesLoading: true,
      repositoryRead: initialRead,
      checkoutRead: initialRead,
      currentCheckoutUnavailableReason: "Checking fixture checkout",
      baseRef: "typed-branch",
      worktreeName: "typed-name",
    });
    const { container, update } = mountCheckout(params);
    await waitForOpen(container);
    const branch = container.querySelector<HTMLInputElement>("#new-session-worktree-base-ref")!;
    const name = container.querySelector<HTMLInputElement>("[data-worktree-name]")!;
    name.focus();
    expect(branch.placeholder).toBe("Loading…");
    expect(container.querySelector<HTMLButtonElement>('[data-value="checkout"]')?.disabled).toBe(
      true,
    );
    initial.reject(new Error("Fixture branch lookup failed"));
    update({
      ...params,
      branchesLoading: false,
      repositoryUnavailable: true,
      currentCheckoutUnavailableReason: "Fixture checkout unavailable",
    });
    await waitForSolid(() => expect(branch.placeholder).toBe("From"));
    expect(container.querySelector("#new-session-worktree-base-ref")).toBe(branch);
    expect(container.querySelector("[data-worktree-name]")).toBe(name);
    expect(document.activeElement).toBe(name);
    expect([branch.value, name.value]).toEqual(["typed-branch", "typed-name"]);

    const retry = createDeferred();
    const retryRead = { completed: retry.promise };
    update({ ...params, repositoryRead: retryRead, checkoutRead: retryRead });
    const branches = { repoRoot: "/fixture", branches: [{ name: "main", kind: "local" as const }] };
    update({
      ...params,
      repositoryRead: retryRead,
      checkoutRead: retryRead,
      currentCheckoutUnavailableReason: undefined,
      branchesLoading: false,
      branches,
      worktreeAvailable: true,
    });
    retry.resolve();
    await waitForSolid(() =>
      expect(container.querySelector('[data-worktree-suggestion="main"]')).not.toBeNull(),
    );
    expect(container.querySelector("#new-session-worktree-base-ref")).toBe(branch);
    expect(container.querySelector("[data-worktree-name]")).toBe(name);
    expect(document.activeElement).toBe(name);
    expect([branch.value, name.value]).toEqual(["typed-branch", "typed-name"]);
    expect(container.querySelector<HTMLButtonElement>('[data-value="checkout"]')?.disabled).toBe(
      false,
    );
  });

  it("keeps suggestion identities current and only confirms valid input", async () => {
    const params = checkoutFixture({ worktreeName: "picker-fixes" });
    const { onConfirm, onPopoverShow, onPopoverHide, onPopoverAfterHide } = params;
    const { container, update } = mountCheckout(params);
    const renderNamed = (worktreeName: string) => update({ ...params, worktreeName });
    await waitForOpen(container);
    onPopoverShow.mockClear();
    const baseRef = container.querySelector<HTMLInputElement>("#new-session-worktree-base-ref")!;
    const name = container.querySelector<HTMLInputElement>("[data-worktree-name]")!;
    input(baseRef, " release ");
    input(name, " picker-fixes ");
    expect(params.onBaseRefInput).toHaveBeenLastCalledWith(" release ");
    expect(params.onWorktreeNameInput).toHaveBeenLastCalledWith(" picker-fixes ");
    keydown(baseRef, "ArrowDown");
    const suggestion = container.querySelector('[data-worktree-suggestion="main"]')!;
    expect(baseRef.getAttribute("aria-activedescendant")).toBe(suggestion.id);
    for (const key of ["ArrowDown", "ArrowUp"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      name.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(name.hasAttribute("aria-activedescendant")).toBe(false);
      expect(suggestion.getAttribute("aria-selected")).toBe("true");
    }

    const trigger = container.querySelector<HTMLButtonElement>("#new-session-checkout-trigger")!;
    expect(trigger.getAttribute("aria-controls")).toBe("new-session-checkout-popover");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    trigger.click();
    flush();
    expect(onPopoverHide).toHaveBeenCalledOnce();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.click();
    flush();
    await waitForOpen(container);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(onPopoverShow).toHaveBeenCalledOnce();
    expect(onPopoverAfterHide).not.toHaveBeenCalled();
    onPopoverShow.mockClear();
    onPopoverHide.mockClear();

    expect(container.textContent).toContain(
      "Creates branch openclaw/picker-fixes in a separate checkout.",
    );
    const suggestionPopup = container.querySelector(".new-session-page__branch-popup")!;
    for (const type of ["overlay-show", "overlay-hide", "overlay-after-hide"]) {
      suggestionPopup.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
    }
    expect(onPopoverShow).not.toHaveBeenCalled();
    expect(onPopoverHide).not.toHaveBeenCalled();
    expect(onPopoverAfterHide).not.toHaveBeenCalled();
    params.onBaseRefInput.mockClear();
    keydown(name, "Enter");
    expect(params.onBaseRefInput).not.toHaveBeenCalled();
    suggestionPopup.dispatchEvent(
      new CustomEvent("overlay-after-hide", { bubbles: true, composed: true }),
    );
    expect(onConfirm).not.toHaveBeenCalled();
    afterHide(container);
    expect(onConfirm).toHaveBeenCalledOnce();

    renderNamed("Not Valid");
    keydown(container.querySelectorAll("input")[1]!, "Enter");
    expect(onConfirm).toHaveBeenCalledOnce();

    const renderBranches = (names: string[]) =>
      update({
        ...params,
        branches: {
          repoRoot: "/repo",
          branches: names.map((branchName) => ({ name: branchName, kind: "local" })),
        },
      });
    const pressBranch = (key: string) => keydown(baseRef, key);
    renderBranches(["main", "release"]);
    input(baseRef, "main");
    pressBranch("ArrowDown");
    renderBranches(["release", "main"]);
    pressBranch("Enter");
    expect(params.onBaseRefInput).toHaveBeenLastCalledWith("main");
    expect(onConfirm).toHaveBeenCalledOnce();

    pressBranch("ArrowDown");
    const retired = container.querySelector<HTMLButtonElement>(
      '[data-worktree-suggestion="release"]',
    )!;
    renderBranches(["main", "next"]);
    expect(baseRef.hasAttribute("aria-activedescendant")).toBe(false);
    vi.mocked(params.onBaseRefInput).mockClear();
    retired.click();
    expect(params.onBaseRefInput).not.toHaveBeenCalled();
    pressBranch("ArrowDown");
    pressBranch("ArrowDown");
    pressBranch("Enter");
    expect(params.onBaseRefInput).toHaveBeenCalledExactlyOnceWith("next");
  });
});
