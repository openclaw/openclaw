# Settings Design Language

Every settings surface (the `/settings` takeover pages plus the Plugins/Skills hubs) uses one structural pattern. Workspace styles live in `ui/src/styles/settings.css`, while controls shared with startup surfaces live in `ui/src/styles/settings-controls.css` and `settings-native-controls.css`. Shared layout and control components live in `ui/src/components/solid/settings-ui.tsx`.

## Anatomy

```
.settings-page                     ← single column, 760px (or --wide: 1120px)
  .settings-section                ← repeated per topic
    .settings-section__heading     ← plain uppercase text label, outside any surface
    .settings-group                ← the ONLY surface (card bg, border, radius-lg)
      .settings-row                ← title/description left, one control right
      .settings-row                ← hairline divider between rows
```

- **Sections are typography, not chrome.** Grouping comes from whitespace + a small uppercase heading — never a card header.
- **Embedded surfaces keep the rhythm.** A container that hosts sections without `.settings-page`'s centered column (tab panels, split layouts) takes `.settings-stack`; never re-space sections with page-local margin rules.
- **Exactly one level of elevation.** A group never contains another card, callout, or bordered box. Nested detail uses `.settings-subrows` (indented rows), a stacked row, or a drill-in nav row.
- **Section notices sit above the group.** Pass alerts through `SettingsSection`'s `notice` prop so they appear between the heading and the group, with the standard section spacing.
- **Row anatomy:** left is title (`--control-ui-text-md`, weight 500) over an optional one-line description (muted, sm). Right is exactly one control: toggle, select, segmented, button, plain value, or chevron (nav). Wide editors use `stacked`; controls that move inline only above the narrow-layout breakpoint use `stackedOnNarrow`.
- **Lists are rows too.** An entity list (plugin, device, session) is a group whose rows carry an action cluster in the control slot — same anatomy as a toggle row.

## Rules

- **Do not narrate unchanged defaults.** Controls and placeholders show the effective value. Omit repetitive “Using default” descriptions; keep useful help, scope, reset controls, and default references for customized values.
- **No status pills.** Status is `SettingsStatus` from `components/solid/settings-ui.tsx` — a dot + plain text (`● Connected`) by default. Permissions use neutral text without dots, with a small checkmark for granted access and aligned action buttons; an ungranted permission is a choice, not an error. Badges (`.settings-count`) exist only for genuine counts.
- **Spacing uses `--space-*` tokens** (`base.css`); no hardcoded paddings/gaps.
- **Motion budget:** color/background transitions only. No enter animations, staggered reveals, or hover glows.
- **Buttons:** default `.btn` (quiet). `--accent` primary at most once per view. Danger actions live in a `danger: true` section at the page bottom.
- **One control set.** Use `SettingsToggleRow` (preferred: whole row clickable, accessible name from its title) or `SettingsToggle` with a required `ariaLabel`, `SettingsSegmented`, `.settings-select`, `.settings-input`. Do not add another toggle or badge variant.
- **Disabled state follows the current form.** Switches and segmented radios use native inputs. A disabled fieldset suppresses activation; controls recover when it is enabled again, while explicitly disabled groups and options stay disabled. Read the input's effective `:disabled` state rather than copying fieldset state into component properties.
- **Every control needs an accessible name.** Row titles are plain text, not `<label>`s — selects/inputs in a control slot must carry `aria-label` (usually the row title string).
- **No new page CSS files for settings surfaces.** Page-specific styles belong in `settings.css` only when a primitive is genuinely missing — extend the system, don't fork it.

## Helpers

```tsx
import { createSignal } from "solid-js";
import {
  SettingsPage,
  SettingsSection,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";

function NotificationSettings() {
  const [checked, setChecked] = createSignal(false);
  return (
    <SettingsPage>
      <SettingsSection title="Notifications">
        <SettingsToggleRow
          title="System notifications"
          description="Show desktop notifications."
          checked={checked()}
          onChange={(value) => setChecked(value)}
        />
      </SettingsSection>
    </SettingsPage>
  );
}
```

Custom content inside a group (tables, meters) is allowed as an escape hatch — keep it inside one `.settings-group` and match row paddings (`--space-3 --space-4`).

Solid views use `SettingsPage`, `SettingsSection`, `SettingsRow`,
`SettingsToggleRow`, and `SettingsSegmented` components. Their children and control
props accept JSX; selection stays with the caller. Returning `false` from a
control's `onChange` restores the accepted value synchronously. The shared native
handlers also preserve direct-activation callbacks and RTL arrow navigation.

Mount settings views inside `ShellLayoutProvider` from
`ui/src/app/shell-layout-traits-solid.tsx`, passing the shell's `ShellLayoutOwner`
and the connected route host. Settings layout boundaries publish their traits
before evaluating descendant content, so measurements see the correct shell
classes.
When a page body loads asynchronously, publish its column trait at the page-shell
boundary, outside the loading branch. The Models shell reserves the narrow
settings column before provider data arrives, keeping its heading in place.
The settings footer reserves one line for connection status and applies the
build chip's `display: contents` layout before the custom element upgrades.

## Phone and native embed layouts

Settings, Skills, and Automations use 44px control targets on phones and coarse-pointer devices. Native embedded settings use the same targets at every width. Text inputs, selects, and textareas keep a 16px font floor to prevent focus zoom.

At 640px and below, form controls fill the row beneath their labels. Navigation rows keep their chevrons beside the label, and toggle rows keep their switches beside the label. Use the existing `stacked` and `stackedOnNarrow` variants for wide editors; short number and time controls can stay together in their control slot. Action clusters wrap, and key/value facts become a single column.

For settings tables, add `.settings-table--stacked` and a translated `data-label` matching each cell's column heading. On phones, each record becomes a group of labeled key/value rows; the table header remains available to assistive technology. Cells without a label, such as an action-only cell, occupy the full record width. Keep the regular table markup and headings for desktop rendering.
