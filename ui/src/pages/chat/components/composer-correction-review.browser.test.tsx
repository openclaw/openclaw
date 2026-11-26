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
    original: "I work Tuesday, no Wednesday shifts are available",
    reason: "corrections-unavailable",
    canKeepOriginal: true,
    onKeepOriginal: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  } satisfies ComposerCorrectionReviewProps;
}

it.each([
  ["Cancel", "onCancel"],
  ["Keep original", "onKeepOriginal"],
] as const)(
  "makes original-only %s reachable and operable by keyboard",
  async (label, callback) => {
    const props = reviewProps();
    const view = mountSolid(() => <ComposerCorrectionReview {...props} />);
    const original = view.getByRole("region", { name: "Original recognized text" });
    const candidate = view.getByRole("region", { name: "Proposed correction" });
    expect(original.textContent).toBe(props.original);
    expect(candidate.textContent).toBe(
      "No correction is available. You can keep the original text or cancel.",
    );
    expect(view.getByRole("status").textContent).toBe(
      "The recognized text needs your review. No correction was applied.",
    );
    await expect
      .element(
        view.getByText(
          "Spoken corrections are unavailable. The recognized text has been kept unchanged.",
        ),
      )
      .toBeVisible();
    await expect.element(view.getByRole("button", { name: "Accept correction" })).toBeDisabled();
    expect(view.container.querySelector("details")).toBeNull();
    expect(original.closest("[aria-live]")).toBeNull();
    expect(candidate.closest("[aria-live]")).toBeNull();

    original.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(candidate);
    const labels = ["Cancel", "Keep original"];
    for (const next of labels.slice(0, labels.indexOf(label) + 1)) {
      await userEvent.tab();
      expect(document.activeElement).toBe(
        view.getByRole("button", { name: new RegExp(`^${next}$`) }),
      );
    }
    await userEvent.keyboard("{Enter}");
    expect(props[callback]).toHaveBeenCalledTimes(1);
    for (const other of ["onCancel", "onKeepOriginal"] as const) {
      if (other !== callback) {
        expect(props[other]).not.toHaveBeenCalled();
      }
    }
  },
);

it.each([
  [390, "light"],
  [390, "dark"],
  [1100, "light"],
  [1100, "dark"],
] as const)("renders the original-only review at %ipx in %s mode", async (width, theme) => {
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
  await expect.element(accept).toBeDisabled();
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
      reason: current ? "corrections-unavailable" : "source-changed",
      canKeepOriginal: current,
    });
    const view = mountSolid(() => <ComposerCorrectionReview {...props} />);
    expect(view.getByRole("region", { name: "Original recognized text" }).textContent).toBe(
      props.original,
    );
    await expect.element(view.getByRole("button", { name: "Accept correction" })).toBeDisabled();
    if (current) {
      await expect.element(view.getByRole("button", { name: "Keep original" })).toBeEnabled();
      await page.screenshot({ path: ".artifacts/m03-review/unavailable-original.png" });
    } else {
      await expect.element(view.getByRole("button", { name: "Keep original" })).toBeDisabled();
    }
    await userEvent.click(view.getByRole("button", { name: /^Cancel$/ }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onKeepOriginal).not.toHaveBeenCalled();
  },
);

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
  expect(document.activeElement).toBe(view.getByRole("button", { name: /^Cancel$/ }));
  await userEvent.tab();
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Keep original" }));
  await userEvent.keyboard("{Enter}");
  expect(props.onKeepOriginal).toHaveBeenCalledTimes(1);
  expect(props.onCancel).not.toHaveBeenCalled();
});

it("defaults to Off and labels the optional original review and transient Literal choice", async () => {
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
  expect(
    view.getByRole("option", { name: "Review original (corrections unavailable)" }).textContent,
  ).toBe("Review original (corrections unavailable)");
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
])(
  "keeps long original text and recovery usable at %ipx with a %ipx root font",
  async (width, fontSize) => {
    // Root font sizing is a layout fixture; it does not qualify browser zoom or assistive technology.
    await page.viewport(width, 900);
    document.documentElement.style.fontSize = `${fontSize}px`;
    const props = reviewProps({
      original: "I work Tuesday, no Wednesday shifts are available. ".repeat(200),
    });
    const view = mountSolid(() => <ComposerCorrectionReview {...props} />);
    const panel = view.getByRole("region", { name: "Review dictated text" });
    const original = view.getByRole("region", { name: "Original recognized text" });
    expect(original.scrollHeight).toBeGreaterThan(original.clientHeight);
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    await expect.element(view.getByRole("button", { name: "Accept correction" })).toBeDisabled();
    for (const label of ["Cancel", "Keep original"]) {
      const button = view.getByRole("button", { name: new RegExp(`^${label}$`) });
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
  },
);
