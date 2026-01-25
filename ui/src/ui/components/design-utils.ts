/**
 * Design System Utilities for Lit Components
 * Provides helper functions and classes for building consistent UI
 */

import { html, type TemplateResult } from "lit";

// Lucide icon type (array of [tag, attrs] tuples)
export type IconNode = [tag: string, attrs: Record<string, string | number | undefined>][];

// ============================================================================
// Icon Utilities
// ============================================================================

/**
 * Creates an SVG icon element from a Lucide icon node definition
 */
export function icon(
  iconNode: IconNode,
  options: { size?: number; class?: string; strokeWidth?: number } = {}
): TemplateResult {
  const { size = 16, class: className = "", strokeWidth = 2 } = options;

  // Build SVG child elements from icon node
  const children = iconNode.map(([tag, attrs]) => {
    const attrStr = Object.entries(attrs)
      .filter(([_, v]) => v !== undefined)
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ");
    return `<${tag} ${attrStr}/>`;
  }).join("");

  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" class="${className}">${children}</svg>`;

  return html`${unsafeSVG(svgStr)}`;
}

// Helper for inline SVG rendering
function unsafeSVG(svgString: string): TemplateResult {
  const template = document.createElement("template");
  template.innerHTML = svgString.trim();
  const node = template.content.firstChild;
  return html`${node}`;
}

// ============================================================================
// Class Name Utilities (similar to clsx/cn)
// ============================================================================

type ClassValue = string | boolean | undefined | null | ClassValue[];

/**
 * Conditionally join class names together
 */
export function cn(...classes: ClassValue[]): string {
  return classes
    .flat()
    .filter((c): c is string => typeof c === "string" && c.length > 0)
    .join(" ");
}

// ============================================================================
// Component Style Helpers
// ============================================================================

/**
 * Button variant classes
 */
export const buttonVariants = {
  primary: "btn btn-primary",
  secondary: "btn btn-secondary",
  ghost: "btn btn-ghost",
  danger: "btn btn-danger",
} as const;

export const buttonSizes = {
  sm: "btn-sm",
  default: "",
  lg: "btn-lg",
  icon: "btn-icon",
} as const;

export function getButtonClasses(
  variant: keyof typeof buttonVariants = "primary",
  size: keyof typeof buttonSizes = "default",
  className?: string
): string {
  return cn(buttonVariants[variant], buttonSizes[size], className);
}

/**
 * Badge variant classes
 */
export const badgeVariants = {
  default: "badge badge-default",
  accent: "badge badge-accent",
  success: "badge badge-success",
  warning: "badge badge-warning",
  danger: "badge badge-danger",
  info: "badge badge-info",
} as const;

export function getBadgeClasses(
  variant: keyof typeof badgeVariants = "default",
  className?: string
): string {
  return cn(badgeVariants[variant], className);
}

/**
 * Input classes
 */
export function getInputClasses(className?: string): string {
  return cn("input", className);
}

/**
 * Card classes
 */
export function getCardClasses(
  options: { interactive?: boolean } = {},
  className?: string
): string {
  return cn("card", options.interactive && "card-interactive", className);
}

// ============================================================================
// Status Helpers
// ============================================================================

export type StatusType = "ok" | "warn" | "danger" | "info" | "default";

export function getStatusDotClass(status: StatusType): string {
  const map: Record<StatusType, string> = {
    ok: "status-dot status-dot-ok",
    warn: "status-dot status-dot-warn",
    danger: "status-dot status-dot-danger",
    info: "status-dot status-dot-info",
    default: "status-dot",
  };
  return map[status] || map.default;
}

export function getStatusBadgeVariant(
  status: StatusType
): keyof typeof badgeVariants {
  const map: Record<StatusType, keyof typeof badgeVariants> = {
    ok: "success",
    warn: "warning",
    danger: "danger",
    info: "info",
    default: "default",
  };
  return map[status] || "default";
}

// ============================================================================
// Animation Helpers
// ============================================================================

/**
 * Staggered animation delay for list items
 */
export function staggerDelay(index: number, baseDelay = 50): string {
  return `animation-delay: ${index * baseDelay}ms`;
}

// ============================================================================
// Template Helpers
// ============================================================================

/**
 * Render an empty state component
 */
export function emptyState(options: {
  icon?: TemplateResult;
  title: string;
  description?: string;
  action?: TemplateResult;
}): TemplateResult {
  return html`
    <div class="empty-state">
      ${options.icon
        ? html`<div class="empty-state-icon">${options.icon}</div>`
        : ""}
      <h3 class="empty-state-title">${options.title}</h3>
      ${options.description
        ? html`<p class="empty-state-description">${options.description}</p>`
        : ""}
      ${options.action || ""}
    </div>
  `;
}

/**
 * Render skeleton loading placeholders
 */
export function skeleton(options: {
  width?: string;
  height?: string;
  rounded?: boolean;
  className?: string;
}): TemplateResult {
  const { width = "100%", height = "1rem", rounded = false, className = "" } = options;
  const style = `width: ${width}; height: ${height};`;
  return html`
    <div
      class="${cn("skeleton", rounded && "rounded-full", className)}"
      style="${style}"
    ></div>
  `;
}

/**
 * Render a list of skeleton items
 */
export function skeletonList(count: number, itemHeight = "3rem"): TemplateResult {
  return html`
    <div class="flex flex-col gap-2">
      ${Array.from({ length: count }, () =>
        skeleton({ height: itemHeight, className: "rounded-lg" })
      )}
    </div>
  `;
}

// ============================================================================
// Form Helpers
// ============================================================================

/**
 * Form field wrapper with label and optional error
 */
export function formField(options: {
  label: string;
  id: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: TemplateResult;
}): TemplateResult {
  return html`
    <div class="form-field">
      <label
        for="${options.id}"
        class="block text-sm font-medium mb-1.5"
        style="color: var(--text-secondary)"
      >
        ${options.label}
        ${options.required ? html`<span style="color: var(--danger)">*</span>` : ""}
      </label>
      ${options.children}
      ${options.error
        ? html`<p class="text-sm mt-1" style="color: var(--danger)">${options.error}</p>`
        : options.hint
          ? html`<p class="text-sm mt-1" style="color: var(--muted)">${options.hint}</p>`
          : ""}
    </div>
  `;
}

// ============================================================================
// Keyboard Navigation Helpers
// ============================================================================

/**
 * Handle arrow key navigation in a list
 */
export function handleListNavigation(
  event: KeyboardEvent,
  currentIndex: number,
  itemCount: number,
  onSelect: (index: number) => void,
  onConfirm?: () => void
): void {
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      onSelect(Math.min(currentIndex + 1, itemCount - 1));
      break;
    case "ArrowUp":
      event.preventDefault();
      onSelect(Math.max(currentIndex - 1, 0));
      break;
    case "Enter":
      event.preventDefault();
      onConfirm?.();
      break;
    case "Home":
      event.preventDefault();
      onSelect(0);
      break;
    case "End":
      event.preventDefault();
      onSelect(itemCount - 1);
      break;
  }
}

// ============================================================================
// Responsive Helpers
// ============================================================================

/**
 * Check if we're on a mobile viewport
 */
export function isMobileViewport(): boolean {
  return window.matchMedia("(max-width: 768px)").matches;
}

/**
 * Check if user prefers reduced motion
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ============================================================================
// Responsive Layout Helpers
// ============================================================================

/**
 * Get responsive padding based on viewport
 */
export function getResponsivePadding(): string {
  if (window.innerWidth <= 480) return "12px";
  if (window.innerWidth <= 768) return "16px";
  return "20px";
}

/**
 * Get CSS class for viewport breakpoint
 */
export function getViewportClass(breakpoint: "sm" | "md" | "lg"): string {
  const width = window.innerWidth;
  switch (breakpoint) {
    case "sm":
      return width <= 480 ? "viewport-sm" : "";
    case "md":
      return width > 480 && width <= 768 ? "viewport-md" : "";
    case "lg":
      return width > 768 ? "viewport-lg" : "";
    default:
      return "";
  }
}

/**
 * Check if current viewport is tablet or smaller
 */
export function isTabletOrSmaller(): boolean {
  return window.matchMedia("(max-width: 768px)").matches;
}

/**
 * Check if current viewport is small mobile
 */
export function isSmallMobile(): boolean {
  return window.matchMedia("(max-width: 480px)").matches;
}

// ============================================================================
// Toggle Row Component Helper
// ============================================================================

export type ToggleRowOptions = {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  icon?: TemplateResult;
  onToggle: (checked: boolean) => void;
};

/**
 * Render a toggle row component (setting with switch)
 */
export function toggleRow(opts: ToggleRowOptions): TemplateResult {
  const { label, description, checked, disabled = false, icon, onToggle } = opts;
  const activeClass = checked ? "setting-toggle-row--active" : "";
  const disabledClass = disabled ? "setting-toggle-row--disabled" : "";

  return html`
    <div class="setting-toggle-row ${activeClass} ${disabledClass}">
      ${icon ? html`<div class="setting-toggle-row__icon">${icon}</div>` : ""}
      <div class="setting-toggle-row__content">
        <span class="setting-toggle-row__label">${label}</span>
        ${description
          ? html`<span class="setting-toggle-row__description">${description}</span>`
          : ""}
      </div>
      <div class="setting-toggle-row__control">
        <label class="cfg-toggle">
          <input
            type="checkbox"
            .checked=${checked}
            ?disabled=${disabled}
            @change=${(e: Event) => onToggle((e.target as HTMLInputElement).checked)}
          />
          <span class="cfg-toggle__track"></span>
        </label>
      </div>
    </div>
  `;
}

// ============================================================================
// Input with Icon Helper
// ============================================================================

export type InputIconOptions = {
  type?: "text" | "password" | "number" | "email";
  placeholder?: string;
  value: string;
  disabled?: boolean;
  icon?: TemplateResult;
  iconPosition?: "left" | "right";
  onInput: (value: string) => void;
  onClear?: () => void;
};

/**
 * Render an input with icon
 */
export function inputWithIcon(opts: InputIconOptions): TemplateResult {
  const {
    type = "text",
    placeholder = "",
    value,
    disabled = false,
    icon,
    iconPosition = "left",
    onInput,
    onClear,
  } = opts;

  const hasValue = value.length > 0;
  const iconLeft = iconPosition === "left" && icon;
  const iconRight = iconPosition === "right" && icon;

  return html`
    <div class="input-with-icon ${iconLeft ? "input-with-icon--left" : ""} ${iconRight ? "input-with-icon--right" : ""}">
      ${iconLeft ? html`<span class="input-with-icon__icon">${icon}</span>` : ""}
      <input
        type=${type}
        class="input-with-icon__input"
        placeholder=${placeholder}
        .value=${value}
        ?disabled=${disabled}
        @input=${(e: Event) => onInput((e.target as HTMLInputElement).value)}
      />
      ${iconRight ? html`<span class="input-with-icon__icon">${icon}</span>` : ""}
      ${hasValue && onClear
        ? html`
            <button
              type="button"
              class="input-with-icon__clear"
              ?disabled=${disabled}
              @click=${onClear}
            >
              ×
            </button>
          `
        : ""}
    </div>
  `;
}

// ============================================================================
// Section Card Helper
// ============================================================================

export type SectionCardOptions = {
  title: string;
  description?: string;
  icon?: TemplateResult;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: TemplateResult;
};

/**
 * Render a section card (for config/settings)
 */
export function sectionCard(opts: SectionCardOptions): TemplateResult {
  const { title, description, icon, collapsible = false, defaultOpen = true, children } = opts;

  if (collapsible) {
    return html`
      <details class="config-section-card" ?open=${defaultOpen}>
        <summary class="config-section-card__header">
          ${icon ? html`<span class="config-section-card__icon">${icon}</span>` : ""}
          <div class="config-section-card__titles">
            <h3 class="config-section-card__title">${title}</h3>
            ${description
              ? html`<p class="config-section-card__desc">${description}</p>`
              : ""}
          </div>
        </summary>
        <div class="config-section-card__content">${children}</div>
      </details>
    `;
  }

  return html`
    <section class="config-section-card">
      <div class="config-section-card__header">
        ${icon ? html`<span class="config-section-card__icon">${icon}</span>` : ""}
        <div class="config-section-card__titles">
          <h3 class="config-section-card__title">${title}</h3>
          ${description
            ? html`<p class="config-section-card__desc">${description}</p>`
            : ""}
        </div>
      </div>
      <div class="config-section-card__content">${children}</div>
    </section>
  `;
}
