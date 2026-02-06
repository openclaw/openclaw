/**
 * Low-level builders for Slack Block Kit components
 * These functions provide type-safe construction of blocks and elements
 */

import type {
  PlainTextObject,
  MrkdwnObject,
  TextObject,
  Option,
  OptionGroup,
  ConfirmationDialog,
  ButtonElement,
  CheckboxesElement,
  RadioButtonsElement,
  SelectStaticElement,
  SelectExternalElement,
  SelectUsersElement,
  SelectConversationsElement,
  SelectChannelsElement,
  MultiSelectStaticElement,
  MultiSelectExternalElement,
  MultiSelectUsersElement,
  MultiSelectConversationsElement,
  MultiSelectChannelsElement,
  PlainTextInputElement,
  EmailInputElement,
  URLInputElement,
  NumberInputElement,
  DatePickerElement,
  DatetimePickerElement,
  TimePickerElement,
  OverflowElement,
  ImageElement,
  ActionsBlock,
  ContextBlock,
  DividerBlock,
  HeaderBlock,
  ImageBlock,
  InputBlock,
  SectionBlock,
  InteractiveElement,
  ContextElement,
  DispatchActionConfig,
  Filter,
} from "./types.js";

// ============================================================================
// Text Object Builders
// ============================================================================

/**
 * Normalize literal escape sequences in text that LLMs sometimes produce.
 * When an LLM generates JSON tool arguments, it may emit "\\n" (literal
 * backslash + n) instead of an actual newline character.  This helper
 * converts those common literal escapes so Slack renders them correctly.
 */
function normalizeEscapes(text: string): string {
  // Replace literal \n and \t that are NOT already a real newline/tab.
  // The regex looks for a real backslash followed by 'n' or 't'.
  return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

export function plainText(text: string, emoji = true): PlainTextObject {
  return {
    type: "plain_text",
    text: normalizeEscapes(text),
    emoji,
  };
}

export function mrkdwn(text: string, verbatim = false): MrkdwnObject {
  return {
    type: "mrkdwn",
    text: normalizeEscapes(text),
    verbatim,
  };
}

// ============================================================================
// Composition Object Builders
// ============================================================================

export function option(text: string, value: string, description?: string, url?: string): Option {
  const opt: Option = {
    text: plainText(text),
    value,
  };

  if (description) {
    opt.description = plainText(description);
  }
  if (url) {
    opt.url = url;
  }

  return opt;
}

export function optionGroup(label: string, options: Option[]): OptionGroup {
  return {
    label: plainText(label),
    options,
  };
}

export function confirmationDialog(params: {
  title: string;
  text: string | TextObject;
  confirm: string;
  deny: string;
  style?: "primary" | "danger";
}): ConfirmationDialog {
  return {
    title: plainText(params.title),
    text: typeof params.text === "string" ? plainText(params.text) : params.text,
    confirm: plainText(params.confirm),
    deny: plainText(params.deny),
    style: params.style,
  };
}

export function dispatchActionConfig(
  triggers: ("on_enter_pressed" | "on_character_entered")[],
): DispatchActionConfig {
  return {
    trigger_actions_on: triggers,
  };
}

export function filter(params: {
  include?: ("im" | "mpim" | "private" | "public")[];
  excludeExternalShared?: boolean;
  excludeBots?: boolean;
}): Filter {
  const f: Filter = {};

  if (params.include) {
    f.include = params.include;
  }
  if (params.excludeExternalShared !== undefined) {
    f.exclude_external_shared_channels = params.excludeExternalShared;
  }
  if (params.excludeBots !== undefined) {
    f.exclude_bot_users = params.excludeBots;
  }

  return f;
}

// ============================================================================
// Interactive Element Builders
// ============================================================================

export function button(params: {
  text: string;
  actionId: string;
  value?: string;
  url?: string;
  style?: "primary" | "danger";
  confirm?: ConfirmationDialog;
  accessibilityLabel?: string;
}): ButtonElement {
  const btn: ButtonElement = {
    type: "button",
    text: plainText(params.text),
    action_id: params.actionId,
  };

  if (params.value !== undefined) {
    btn.value = params.value;
  }
  if (params.url) {
    btn.url = params.url;
  }
  if (params.style) {
    btn.style = params.style;
  }
  if (params.confirm) {
    btn.confirm = params.confirm;
  }
  if (params.accessibilityLabel) {
    btn.accessibility_label = params.accessibilityLabel;
  }

  return btn;
}

export function checkboxes(params: {
  actionId: string;
  options: Option[];
  initialOptions?: Option[];
  confirm?: ConfirmationDialog;
  focusOnLoad?: boolean;
}): CheckboxesElement {
  const elem: CheckboxesElement = {
    type: "checkboxes",
    action_id: params.actionId,
    options: params.options,
  };

  if (params.initialOptions) {
    elem.initial_options = params.initialOptions;
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function radioButtons(params: {
  actionId: string;
  options: Option[];
  initialOption?: Option;
  confirm?: ConfirmationDialog;
  focusOnLoad?: boolean;
}): RadioButtonsElement {
  const elem: RadioButtonsElement = {
    type: "radio_buttons",
    action_id: params.actionId,
    options: params.options,
  };

  if (params.initialOption) {
    elem.initial_option = params.initialOption;
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function staticSelect(params: {
  actionId: string;
  options?: Option[];
  optionGroups?: OptionGroup[];
  initialOption?: Option;
  placeholder?: string;
  confirm?: ConfirmationDialog;
  focusOnLoad?: boolean;
}): SelectStaticElement {
  const elem: SelectStaticElement = {
    type: "static_select",
    action_id: params.actionId,
  };

  if (params.options) {
    elem.options = params.options;
  }
  if (params.optionGroups) {
    elem.option_groups = params.optionGroups;
  }
  if (params.initialOption) {
    elem.initial_option = params.initialOption;
  }
  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function externalSelect(params: {
  actionId: string;
  minQueryLength?: number;
  initialOption?: Option;
  placeholder?: string;
  confirm?: ConfirmationDialog;
  focusOnLoad?: boolean;
}): SelectExternalElement {
  const elem: SelectExternalElement = {
    type: "external_select",
    action_id: params.actionId,
  };

  if (params.minQueryLength !== undefined) {
    elem.min_query_length = params.minQueryLength;
  }
  if (params.initialOption) {
    elem.initial_option = params.initialOption;
  }
  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function usersSelect(params: {
  actionId: string;
  initialUser?: string;
  placeholder?: string;
  confirm?: ConfirmationDialog;
  focusOnLoad?: boolean;
}): SelectUsersElement {
  const elem: SelectUsersElement = {
    type: "users_select",
    action_id: params.actionId,
  };

  if (params.initialUser) {
    elem.initial_user = params.initialUser;
  }
  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function conversationsSelect(params: {
  actionId: string;
  initialConversation?: string;
  defaultToCurrent?: boolean;
  placeholder?: string;
  confirm?: ConfirmationDialog;
  responseUrlEnabled?: boolean;
  filter?: Filter;
  focusOnLoad?: boolean;
}): SelectConversationsElement {
  const elem: SelectConversationsElement = {
    type: "conversations_select",
    action_id: params.actionId,
  };

  if (params.initialConversation) {
    elem.initial_conversation = params.initialConversation;
  }
  if (params.defaultToCurrent !== undefined) {
    elem.default_to_current_conversation = params.defaultToCurrent;
  }
  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.responseUrlEnabled !== undefined) {
    elem.response_url_enabled = params.responseUrlEnabled;
  }
  if (params.filter) {
    elem.filter = params.filter;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function channelsSelect(params: {
  actionId: string;
  initialChannel?: string;
  placeholder?: string;
  confirm?: ConfirmationDialog;
  responseUrlEnabled?: boolean;
  focusOnLoad?: boolean;
}): SelectChannelsElement {
  const elem: SelectChannelsElement = {
    type: "channels_select",
    action_id: params.actionId,
  };

  if (params.initialChannel) {
    elem.initial_channel = params.initialChannel;
  }
  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.responseUrlEnabled !== undefined) {
    elem.response_url_enabled = params.responseUrlEnabled;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function multiStaticSelect(params: {
  actionId: string;
  options?: Option[];
  optionGroups?: OptionGroup[];
  initialOptions?: Option[];
  placeholder?: string;
  confirm?: ConfirmationDialog;
  maxSelectedItems?: number;
  focusOnLoad?: boolean;
}): MultiSelectStaticElement {
  const elem: MultiSelectStaticElement = {
    type: "multi_static_select",
    action_id: params.actionId,
  };

  if (params.options) {
    elem.options = params.options;
  }
  if (params.optionGroups) {
    elem.option_groups = params.optionGroups;
  }
  if (params.initialOptions) {
    elem.initial_options = params.initialOptions;
  }
  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.maxSelectedItems !== undefined) {
    elem.max_selected_items = params.maxSelectedItems;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function multiExternalSelect(params: {
  actionId: string;
  minQueryLength?: number;
  initialOptions?: Option[];
  placeholder?: string;
  confirm?: ConfirmationDialog;
  maxSelectedItems?: number;
  focusOnLoad?: boolean;
}): MultiSelectExternalElement {
  const elem: MultiSelectExternalElement = {
    type: "multi_external_select",
    action_id: params.actionId,
  };

  if (params.minQueryLength !== undefined) {
    elem.min_query_length = params.minQueryLength;
  }
  if (params.initialOptions) {
    elem.initial_options = params.initialOptions;
  }
  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.maxSelectedItems !== undefined) {
    elem.max_selected_items = params.maxSelectedItems;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function multiUsersSelect(params: {
  actionId: string;
  initialUsers?: string[];
  placeholder?: string;
  confirm?: ConfirmationDialog;
  maxSelectedItems?: number;
  focusOnLoad?: boolean;
}): MultiSelectUsersElement {
  const elem: MultiSelectUsersElement = {
    type: "multi_users_select",
    action_id: params.actionId,
  };

  if (params.initialUsers) {
    elem.initial_users = params.initialUsers;
  }
  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.maxSelectedItems !== undefined) {
    elem.max_selected_items = params.maxSelectedItems;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function multiConversationsSelect(params: {
  actionId: string;
  initialConversations?: string[];
  defaultToCurrent?: boolean;
  placeholder?: string;
  confirm?: ConfirmationDialog;
  maxSelectedItems?: number;
  filter?: Filter;
  focusOnLoad?: boolean;
}): MultiSelectConversationsElement {
  const elem: MultiSelectConversationsElement = {
    type: "multi_conversations_select",
    action_id: params.actionId,
  };

  if (params.initialConversations) {
    elem.initial_conversations = params.initialConversations;
  }
  if (params.defaultToCurrent !== undefined) {
    elem.default_to_current_conversation = params.defaultToCurrent;
  }
  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.maxSelectedItems !== undefined) {
    elem.max_selected_items = params.maxSelectedItems;
  }
  if (params.filter) {
    elem.filter = params.filter;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function multiChannelsSelect(params: {
  actionId: string;
  initialChannels?: string[];
  placeholder?: string;
  confirm?: ConfirmationDialog;
  maxSelectedItems?: number;
  focusOnLoad?: boolean;
}): MultiSelectChannelsElement {
  const elem: MultiSelectChannelsElement = {
    type: "multi_channels_select",
    action_id: params.actionId,
  };

  if (params.initialChannels) {
    elem.initial_channels = params.initialChannels;
  }
  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.maxSelectedItems !== undefined) {
    elem.max_selected_items = params.maxSelectedItems;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function textInput(params: {
  actionId: string;
  placeholder?: string;
  initialValue?: string;
  multiline?: boolean;
  minLength?: number;
  maxLength?: number;
  dispatchActionConfig?: DispatchActionConfig;
  focusOnLoad?: boolean;
}): PlainTextInputElement {
  const elem: PlainTextInputElement = {
    type: "plain_text_input",
    action_id: params.actionId,
  };

  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.initialValue !== undefined) {
    elem.initial_value = params.initialValue;
  }
  if (params.multiline !== undefined) {
    elem.multiline = params.multiline;
  }
  if (params.minLength !== undefined) {
    elem.min_length = params.minLength;
  }
  if (params.maxLength !== undefined) {
    elem.max_length = params.maxLength;
  }
  if (params.dispatchActionConfig) {
    elem.dispatch_action_config = params.dispatchActionConfig;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function emailInput(params: {
  actionId: string;
  placeholder?: string;
  initialValue?: string;
  dispatchActionConfig?: DispatchActionConfig;
  focusOnLoad?: boolean;
}): EmailInputElement {
  const elem: EmailInputElement = {
    type: "email_text_input",
    action_id: params.actionId,
  };

  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.initialValue !== undefined) {
    elem.initial_value = params.initialValue;
  }
  if (params.dispatchActionConfig) {
    elem.dispatch_action_config = params.dispatchActionConfig;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function urlInput(params: {
  actionId: string;
  placeholder?: string;
  initialValue?: string;
  dispatchActionConfig?: DispatchActionConfig;
  focusOnLoad?: boolean;
}): URLInputElement {
  const elem: URLInputElement = {
    type: "url_text_input",
    action_id: params.actionId,
  };

  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.initialValue !== undefined) {
    elem.initial_value = params.initialValue;
  }
  if (params.dispatchActionConfig) {
    elem.dispatch_action_config = params.dispatchActionConfig;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function numberInput(params: {
  actionId: string;
  isDecimalAllowed: boolean;
  placeholder?: string;
  initialValue?: string;
  minValue?: string;
  maxValue?: string;
  dispatchActionConfig?: DispatchActionConfig;
  focusOnLoad?: boolean;
}): NumberInputElement {
  const elem: NumberInputElement = {
    type: "number_input",
    action_id: params.actionId,
    is_decimal_allowed: params.isDecimalAllowed,
  };

  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.initialValue !== undefined) {
    elem.initial_value = params.initialValue;
  }
  if (params.minValue !== undefined) {
    elem.min_value = params.minValue;
  }
  if (params.maxValue !== undefined) {
    elem.max_value = params.maxValue;
  }
  if (params.dispatchActionConfig) {
    elem.dispatch_action_config = params.dispatchActionConfig;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function datePicker(params: {
  actionId: string;
  placeholder?: string;
  initialDate?: string;
  confirm?: ConfirmationDialog;
  focusOnLoad?: boolean;
}): DatePickerElement {
  const elem: DatePickerElement = {
    type: "datepicker",
    action_id: params.actionId,
  };

  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.initialDate) {
    elem.initial_date = params.initialDate;
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function datetimePicker(params: {
  actionId: string;
  initialDateTime?: number;
  confirm?: ConfirmationDialog;
  focusOnLoad?: boolean;
}): DatetimePickerElement {
  const elem: DatetimePickerElement = {
    type: "datetimepicker",
    action_id: params.actionId,
  };

  if (params.initialDateTime !== undefined) {
    elem.initial_date_time = params.initialDateTime;
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function timePicker(params: {
  actionId: string;
  placeholder?: string;
  initialTime?: string;
  timezone?: string;
  confirm?: ConfirmationDialog;
  focusOnLoad?: boolean;
}): TimePickerElement {
  const elem: TimePickerElement = {
    type: "timepicker",
    action_id: params.actionId,
  };

  if (params.placeholder) {
    elem.placeholder = plainText(params.placeholder);
  }
  if (params.initialTime) {
    elem.initial_time = params.initialTime;
  }
  if (params.timezone) {
    elem.timezone = params.timezone;
  }
  if (params.confirm) {
    elem.confirm = params.confirm;
  }
  if (params.focusOnLoad !== undefined) {
    elem.focus_on_load = params.focusOnLoad;
  }

  return elem;
}

export function overflow(params: {
  actionId: string;
  options: Option[];
  confirm?: ConfirmationDialog;
}): OverflowElement {
  const elem: OverflowElement = {
    type: "overflow",
    action_id: params.actionId,
    options: params.options,
  };

  if (params.confirm) {
    elem.confirm = params.confirm;
  }

  return elem;
}

export function image(imageUrl: string, altText: string): ImageElement {
  return {
    type: "image",
    image_url: imageUrl,
    alt_text: altText,
  };
}

// ============================================================================
// Block Builders
// ============================================================================

export function section(params: {
  text?: string | TextObject;
  blockId?: string;
  fields?: TextObject[];
  accessory?: InteractiveElement | ImageElement;
}): SectionBlock {
  const block: SectionBlock = {
    type: "section",
  };

  if (params.text) {
    block.text = typeof params.text === "string" ? mrkdwn(params.text) : params.text;
  }
  if (params.blockId) {
    block.block_id = params.blockId;
  }
  if (params.fields) {
    block.fields = params.fields;
  }
  if (params.accessory) {
    block.accessory = params.accessory;
  }

  return block;
}

export function actions(elements: InteractiveElement[], blockId?: string): ActionsBlock {
  const block: ActionsBlock = {
    type: "actions",
    elements,
  };

  if (blockId) {
    block.block_id = blockId;
  }

  return block;
}

export function context(elements: ContextElement[], blockId?: string): ContextBlock {
  const block: ContextBlock = {
    type: "context",
    elements,
  };

  if (blockId) {
    block.block_id = blockId;
  }

  return block;
}

export function divider(blockId?: string): DividerBlock {
  const block: DividerBlock = {
    type: "divider",
  };

  if (blockId) {
    block.block_id = blockId;
  }

  return block;
}

export function header(text: string, blockId?: string): HeaderBlock {
  const block: HeaderBlock = {
    type: "header",
    text: plainText(text),
  };

  if (blockId) {
    block.block_id = blockId;
  }

  return block;
}

export function imageBlock(params: {
  imageUrl: string;
  altText: string;
  title?: string;
  blockId?: string;
}): ImageBlock {
  const block: ImageBlock = {
    type: "image",
    image_url: params.imageUrl,
    alt_text: params.altText,
  };

  if (params.title) {
    block.title = plainText(params.title);
  }
  if (params.blockId) {
    block.block_id = params.blockId;
  }

  return block;
}

export function input(params: {
  label: string;
  element:
    | PlainTextInputElement
    | EmailInputElement
    | URLInputElement
    | NumberInputElement
    | CheckboxesElement
    | RadioButtonsElement
    | SelectStaticElement
    | SelectExternalElement
    | SelectUsersElement
    | SelectConversationsElement
    | SelectChannelsElement
    | MultiSelectStaticElement
    | MultiSelectExternalElement
    | MultiSelectUsersElement
    | MultiSelectConversationsElement
    | MultiSelectChannelsElement
    | DatePickerElement
    | DatetimePickerElement
    | TimePickerElement;
  blockId?: string;
  hint?: string;
  optional?: boolean;
  dispatchAction?: boolean;
}): InputBlock {
  const block: InputBlock = {
    type: "input",
    label: plainText(params.label),
    element: params.element,
  };

  if (params.blockId) {
    block.block_id = params.blockId;
  }
  if (params.hint) {
    block.hint = plainText(params.hint);
  }
  if (params.optional !== undefined) {
    block.optional = params.optional;
  }
  if (params.dispatchAction !== undefined) {
    block.dispatch_action = params.dispatchAction;
  }

  return block;
}
