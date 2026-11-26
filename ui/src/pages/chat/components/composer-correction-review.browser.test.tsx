import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { ComposerCorrectionControls } from "./composer-correction-controls.tsx";
import { ComposerCorrectionRecovery } from "./composer-correction-recovery.tsx";
import {
  ComposerCorrectionReview,
  type ComposerCorrectionReviewProps,
} from "./composer-correction-review.tsx";
import "../../../styles/base.css";
import "../../../styles/components.css";

const initialViewport = { width: window.innerWidth, height: window.innerHeight };
const initialFontSize = document.documentElement.style.fontSize;
const initialTheme = document.documentElement.dataset.themeMode;

afterEach(async () => {
  cleanupSolid();
  document.documentElement.style.fontSize = initialFontSize;
  if (initialTheme === undefined) {
    delete document.documentElement.dataset.themeMode;
  } else {
    document.documentElement.dataset.themeMode = initialTheme;
  }
  await page.viewport(initialViewport.width, initialViewport.height);
});

function reviewProps(overrides: Partial<ComposerCorrectionReviewProps> = {}) {
  return {
    original: "Do not send it Tuesday sorry Wednesday",
    candidate: "Do not send it Wednesday",
    changes: [{ id: "day", original: "Tuesday sorry Wednesday", replacement: "Wednesday" }],
    correctionCount: 1,
    reason: "metadata-incomplete",
    canAccept: true,
    canKeepOriginal: true,
    onKeepOriginal: vi.fn(),
    onAcceptCorrection: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  } satisfies ComposerCorrectionReviewProps;
}

it.each([
  ["Cancel", "onCancel"],
  ["Keep original", "onKeepOriginal"],
  ["Accept correction", "onAcceptCorrection"],
] as const)("makes %s reachable and operable by keyboard", async (label, callback) => {
  const props = reviewProps();
  const view = mountSolid(() => <ComposerCorrectionReview {...props} />);
  const original = view.getByRole("region", { name: "Original recognized text" });
  const candidate = view.getByRole("region", { name: "Proposed correction" });
  expect(original.textContent).toBe(props.original);
  expect(candidate.textContent).toBe(props.candidate);
  expect(view.getByRole("status").textContent).toBe("1 proposed correction is ready for review.");
  expect(original.closest("[aria-live]")).toBeNull();
  expect(candidate.closest("[aria-live]")).toBeNull();

  original.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(candidate);
  await userEvent.tab();
  const summary = view.getByText("Inspect changed words");
  expect(document.activeElement).toBe(summary);
  await userEvent.keyboard("{Enter}");
  expect(view.container.querySelector("details")?.open).toBe(true);
  expect(view.getByText("Before").closest("[aria-live]")).toBeNull();

  const labels = ["Cancel", "Keep original", "Accept correction"];
  for (const next of labels.slice(0, labels.indexOf(label) + 1)) {
    await userEvent.tab();
    expect(document.activeElement).toBe(view.getByRole("button", { name: next, exact: true }));
  }
  await userEvent.keyboard("{Enter}");
  expect(props[callback]).toHaveBeenCalledTimes(1);
  for (const other of ["onCancel", "onKeepOriginal", "onAcceptCorrection"] as const) {
    if (other !== callback) {
      expect(props[other]).not.toHaveBeenCalled();
    }
  }
});

it.each([
  [390, "light"],
  [390, "dark"],
  [1100, "light"],
  [1100, "dark"],
] as const)("renders review evidence at %ipx in %s mode", async (width, theme) => {
  await page.viewport(width, 1050);
  document.documentElement.dataset.themeMode = theme;
  const props = reviewProps();
  const view = mountSolid(() => (
    <main style={{ padding: "1rem", display: "grid", gap: "1rem" }}>
      <ComposerCorrectionControls
        policy="explicit"
        literal={false}
        onPolicyChange={() => {}}
        onLiteralChange={() => {}}
      />
      <ComposerCorrectionReview {...props} />
    </main>
  ));
  const accept = view.getByRole("button", { name: "Accept correction" });
  await expect.element(accept).toBeVisible();
  const rect = accept.getBoundingClientRect();
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  await page.screenshot({ path: `.artifacts/m03-review/${theme}-${width}-review.png` });
});

it.each([true, false])(
  "retains original text and respects review eligibility (current=%s)",
  async (current) => {
    await page.viewport(390, 900);
    document.documentElement.dataset.themeMode = "dark";
    const props = reviewProps({
      original: "Tell John that John should call change John to James",
      candidate: null,
      changes: [],
      correctionCount: 0,
      reason: current ? "ambiguous-target" : "source-changed",
      canAccept: false,
      canKeepOriginal: current,
    });
    const view = mountSolid(() => <ComposerCorrectionReview {...props} />);
    expect(view.getByRole("region", { name: "Original recognized text" }).textContent).toBe(
      props.original,
    );
    await expect.element(view.getByRole("button", { name: "Accept correction" })).toBeDisabled();
    if (current) {
      await expect.element(view.getByRole("button", { name: "Keep original" })).toBeEnabled();
      await page.screenshot({ path: ".artifacts/m03-review/ambiguous-original.png" });
    } else {
      await expect.element(view.getByRole("button", { name: "Keep original" })).toBeDisabled();
    }
    await userEvent.click(view.getByRole("button", { name: "Cancel", exact: true }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onAcceptCorrection).not.toHaveBeenCalled();
    expect(props.onKeepOriginal).not.toHaveBeenCalled();
  },
);

it("allows an explicitly reviewed retraction whose candidate is empty", async () => {
  const props = reviewProps({
    original: "A complete sentence. Scratch that last sentence",
    candidate: "",
    changes: [{ id: "sentence", original: "A complete sentence.", replacement: "" }],
  });
  const view = mountSolid(() => <ComposerCorrectionReview {...props} />);
  await expect.element(view.getByRole("button", { name: "Accept correction" })).toBeEnabled();
  expect(view.getByRole("region", { name: "Proposed correction" }).textContent).toBe(
    "No dictated text remains after this correction.",
  );
  await userEvent.click(view.getByRole("button", { name: "Accept correction" }));
  expect(props.onAcceptCorrection).toHaveBeenCalledTimes(1);
});

it("keeps recognized text recoverable by keyboard when the optional review fails", async () => {
  await page.viewport(390, 900);
  document.documentElement.dataset.themeMode = "dark";
  const props = reviewProps();
  const UnavailableReview = () => {
    throw new Error("Synthetic unavailable review chunk");
  };
  const view = mountSolid(() => (
    <ChatLazyBoundary recovery={<ComposerCorrectionRecovery {...props} />}>
      <UnavailableReview />
    </ChatLazyBoundary>
  ));
  const original = view.getByRole("textbox", { name: "Original recognized text" });
  await expect.element(original).toHaveValue(props.original);
  expect(original.closest("[aria-live]")).toBeNull();
  await page.screenshot({ path: ".artifacts/m03-review/unavailable-review-recovery.png" });
  original.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Cancel", exact: true }));
  await userEvent.tab();
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Keep original" }));
  await userEvent.keyboard("{Enter}");
  expect(props.onKeepOriginal).toHaveBeenCalledTimes(1);
  expect(props.onCancel).not.toHaveBeenCalled();
});

it("offers Off, explicit English corrections, and a separate transient Literal choice", async () => {
  const onPolicyChange = vi.fn();
  const onLiteralChange = vi.fn();
  const view = mountSolid(() => {
    const [policy, setPolicy] = createSignal<"off" | "explicit">("off");
    const [literal, setLiteral] = createSignal(false);
    return (
      <ComposerCorrectionControls
        policy={policy()}
        literal={literal()}
        onPolicyChange={(value) => {
          onPolicyChange(value);
          setPolicy(value);
        }}
        onLiteralChange={(value) => {
          onLiteralChange(value);
          setLiteral(value);
        }}
      />
    );
  });
  const select = view.getByRole("combobox", { name: "Spoken corrections" });
  const literal = view.getByRole("checkbox", { name: "Literal for this recording" });
  await expect.element(select).toHaveValue("off");
  await expect.element(literal).toBeDisabled();
  await userEvent.selectOptions(select, "explicit");
  expect(onPolicyChange).toHaveBeenCalledWith("explicit");
  await expect.element(literal).toBeEnabled();
  literal.focus();
  await userEvent.keyboard(" ");
  expect(onLiteralChange).toHaveBeenCalledWith(true);
  await expect.element(literal).toBeChecked();
});

it.each([
  [1280, 16],
  [400, 32],
])("keeps long text and all choices usable at %ipx with %ipx text", async (width, fontSize) => {
  await page.viewport(width, 900);
  document.documentElement.style.fontSize = `${fontSize}px`;
  const props = reviewProps({
    original: "Do not send Tuesday sorry Wednesday. ".repeat(200),
    candidate: "Do not send Wednesday. ".repeat(200),
  });
  const view = mountSolid(() => <ComposerCorrectionReview {...props} />);
  const panel = view.getByRole("region", { name: "Review spoken corrections" });
  const original = view.getByRole("region", { name: "Original recognized text" });
  expect(original.scrollHeight).toBeGreaterThan(original.clientHeight);
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
  for (const label of ["Cancel", "Keep original", "Accept correction"]) {
    const button = view.getByRole("button", { name: label, exact: true });
    button.focus();
    await expect.element(button).toBeVisible();
    const rect = button.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(rect.top).toBeGreaterThanOrEqual(panel.getBoundingClientRect().top);
    expect(rect.bottom).toBeLessThanOrEqual(panel.getBoundingClientRect().bottom);
  }
});
