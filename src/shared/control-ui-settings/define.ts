/** One setting a Settings page shows. */
export type ControlUiSettingEntry = {
  /** The row's title in English; names the setting where no link can be opened. */
  readonly label: string;
  /** Setting ID of the disclosure that hides this row until it opens. */
  readonly within?: string;
  /**
   * Config section that shows the row on a page with several, when the ID does not start
   * with it; a link opens that section.
   */
  readonly section?: string;
};

/** A Settings page and the settings it shows, keyed by setting ID. */
export type ControlUiSettingsPage<Ids extends string = string> = {
  /** Route path below the Control UI base path. */
  readonly path: string;
  /** Page name as the sidebar shows it, such as `Models` or `Agents > Overview`. */
  readonly title: string;
  /** The path continues with the agent ID, then `agentPanel` when present. */
  readonly agent?: true;
  readonly agentPanel?: string;
  /**
   * Settings on the page. A row that edits one config value uses that value's path as its ID;
   * other IDs start with a name that is not a config section, such as `local.` for
   * preferences saved in the browser. A key ending in `.*` names one row per item, such as
   * `providers.*`; the row fills in the item, as in `providers.openai`.
   */
  readonly settings: { readonly [Id in Ids]: ControlUiSettingEntry };
};

export function defineSettingsPage<const Ids extends string>(
  page: ControlUiSettingsPage<Ids>,
): ControlUiSettingsPage<Ids> {
  return page;
}
