import crypto from "node:crypto";
import { Button, ChannelSelectMenu, CheckboxGroup, Container, File, Label, LinkButton, MediaGallery, MentionableSelectMenu, Modal, RadioGroup, RoleSelectMenu, Row, Section, Separator, StringSelectMenu, TextDisplay, TextInput, Thumbnail, UserSelectMenu, parseCustomId, } from "@buape/carbon";
import { ButtonStyle, MessageFlags, TextInputStyle } from "discord-api-types/v10";
export const DISCORD_COMPONENT_CUSTOM_ID_KEY = "occomp";
export const DISCORD_MODAL_CUSTOM_ID_KEY = "ocmodal";
export const DISCORD_COMPONENT_ATTACHMENT_PREFIX = "attachment://";
const BLOCK_ALIASES = new Map([
    ["row", "actions"],
    ["action-row", "actions"],
]);
function createShortId(prefix) {
    return `${prefix}${crypto.randomBytes(6).toString("base64url")}`;
}
function requireObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}
function readString(value, label, opts) {
    if (typeof value !== "string") {
        throw new Error(`${label} must be a string`);
    }
    const trimmed = value.trim();
    if (!opts?.allowEmpty && !trimmed) {
        throw new Error(`${label} cannot be empty`);
    }
    return opts?.allowEmpty ? value : trimmed;
}
function readOptionalString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
function readOptionalStringArray(value, label) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array`);
    }
    if (value.length === 0) {
        return undefined;
    }
    return value.map((entry, index) => readString(entry, `${label}[${index}]`));
}
function readOptionalNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
    }
    return value;
}
function normalizeModalFieldName(value, index) {
    const trimmed = value?.trim();
    if (trimmed) {
        return trimmed;
    }
    return `field_${index + 1}`;
}
function normalizeAttachmentRef(value, label) {
    const trimmed = value.trim();
    if (!trimmed.startsWith(DISCORD_COMPONENT_ATTACHMENT_PREFIX)) {
        throw new Error(`${label} must start with "${DISCORD_COMPONENT_ATTACHMENT_PREFIX}"`);
    }
    const attachmentName = trimmed.slice(DISCORD_COMPONENT_ATTACHMENT_PREFIX.length).trim();
    if (!attachmentName) {
        throw new Error(`${label} must include an attachment filename`);
    }
    return `${DISCORD_COMPONENT_ATTACHMENT_PREFIX}${attachmentName}`;
}
export function resolveDiscordComponentAttachmentName(value) {
    const trimmed = value.trim();
    if (!trimmed.startsWith(DISCORD_COMPONENT_ATTACHMENT_PREFIX)) {
        throw new Error(`Attachment reference must start with "${DISCORD_COMPONENT_ATTACHMENT_PREFIX}"`);
    }
    const attachmentName = trimmed.slice(DISCORD_COMPONENT_ATTACHMENT_PREFIX.length).trim();
    if (!attachmentName) {
        throw new Error("Attachment reference must include a filename");
    }
    return attachmentName;
}
function mapButtonStyle(style) {
    switch ((style ?? "primary").toLowerCase()) {
        case "secondary":
            return ButtonStyle.Secondary;
        case "success":
            return ButtonStyle.Success;
        case "danger":
            return ButtonStyle.Danger;
        case "link":
            return ButtonStyle.Link;
        case "primary":
        default:
            return ButtonStyle.Primary;
    }
}
function mapTextInputStyle(style) {
    return style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short;
}
function normalizeBlockType(raw) {
    const lowered = raw.trim().toLowerCase();
    return BLOCK_ALIASES.get(lowered) ?? lowered;
}
function parseSelectOptions(raw, label) {
    if (raw === undefined) {
        return undefined;
    }
    if (!Array.isArray(raw)) {
        throw new Error(`${label} must be an array`);
    }
    return raw.map((entry, index) => {
        const obj = requireObject(entry, `${label}[${index}]`);
        return {
            label: readString(obj.label, `${label}[${index}].label`),
            value: readString(obj.value, `${label}[${index}].value`),
            description: readOptionalString(obj.description),
            emoji: typeof obj.emoji === "object" && obj.emoji && !Array.isArray(obj.emoji)
                ? {
                    name: readString(obj.emoji.name, `${label}[${index}].emoji.name`),
                    id: readOptionalString(obj.emoji.id),
                    animated: typeof obj.emoji.animated === "boolean"
                        ? obj.emoji.animated
                        : undefined,
                }
                : undefined,
            default: typeof obj.default === "boolean" ? obj.default : undefined,
        };
    });
}
function parseButtonSpec(raw, label) {
    const obj = requireObject(raw, label);
    const style = readOptionalString(obj.style);
    const url = readOptionalString(obj.url);
    if ((style === "link" || url) && !url) {
        throw new Error(`${label}.url is required for link buttons`);
    }
    return {
        label: readString(obj.label, `${label}.label`),
        style,
        url,
        emoji: typeof obj.emoji === "object" && obj.emoji && !Array.isArray(obj.emoji)
            ? {
                name: readString(obj.emoji.name, `${label}.emoji.name`),
                id: readOptionalString(obj.emoji.id),
                animated: typeof obj.emoji.animated === "boolean"
                    ? obj.emoji.animated
                    : undefined,
            }
            : undefined,
        disabled: typeof obj.disabled === "boolean" ? obj.disabled : undefined,
        allowedUsers: readOptionalStringArray(obj.allowedUsers, `${label}.allowedUsers`),
    };
}
function parseSelectSpec(raw, label) {
    const obj = requireObject(raw, label);
    const type = readOptionalString(obj.type);
    const allowedTypes = [
        "string",
        "user",
        "role",
        "mentionable",
        "channel",
    ];
    if (type && !allowedTypes.includes(type)) {
        throw new Error(`${label}.type must be one of ${allowedTypes.join(", ")}`);
    }
    return {
        type,
        placeholder: readOptionalString(obj.placeholder),
        minValues: readOptionalNumber(obj.minValues),
        maxValues: readOptionalNumber(obj.maxValues),
        options: parseSelectOptions(obj.options, `${label}.options`),
    };
}
function parseModalField(raw, label, index) {
    const obj = requireObject(raw, label);
    const type = readString(obj.type, `${label}.type`).toLowerCase();
    const supported = [
        "text",
        "checkbox",
        "radio",
        "select",
        "role-select",
        "user-select",
    ];
    if (!supported.includes(type)) {
        throw new Error(`${label}.type must be one of ${supported.join(", ")}`);
    }
    const options = parseSelectOptions(obj.options, `${label}.options`);
    if (["checkbox", "radio", "select"].includes(type) && (!options || options.length === 0)) {
        throw new Error(`${label}.options is required for ${type} fields`);
    }
    return {
        type,
        name: normalizeModalFieldName(readOptionalString(obj.name), index),
        label: readString(obj.label, `${label}.label`),
        description: readOptionalString(obj.description),
        placeholder: readOptionalString(obj.placeholder),
        required: typeof obj.required === "boolean" ? obj.required : undefined,
        options,
        minValues: readOptionalNumber(obj.minValues),
        maxValues: readOptionalNumber(obj.maxValues),
        minLength: readOptionalNumber(obj.minLength),
        maxLength: readOptionalNumber(obj.maxLength),
        style: readOptionalString(obj.style),
    };
}
function parseComponentBlock(raw, label) {
    const obj = requireObject(raw, label);
    const typeRaw = readString(obj.type, `${label}.type`).toLowerCase();
    const type = normalizeBlockType(typeRaw);
    switch (type) {
        case "text":
            return {
                type: "text",
                text: readString(obj.text, `${label}.text`),
            };
        case "section": {
            const text = readOptionalString(obj.text);
            const textsRaw = obj.texts;
            const texts = Array.isArray(textsRaw)
                ? textsRaw.map((entry, idx) => readString(entry, `${label}.texts[${idx}]`))
                : undefined;
            if (!text && (!texts || texts.length === 0)) {
                throw new Error(`${label}.text or ${label}.texts is required for section blocks`);
            }
            let accessory;
            if (obj.accessory !== undefined) {
                const accessoryObj = requireObject(obj.accessory, `${label}.accessory`);
                const accessoryType = readString(accessoryObj.type, `${label}.accessory.type`).toLowerCase();
                if (accessoryType === "thumbnail") {
                    accessory = {
                        type: "thumbnail",
                        url: readString(accessoryObj.url, `${label}.accessory.url`),
                    };
                }
                else if (accessoryType === "button") {
                    accessory = {
                        type: "button",
                        button: parseButtonSpec(accessoryObj.button, `${label}.accessory.button`),
                    };
                }
                else {
                    throw new Error(`${label}.accessory.type must be "thumbnail" or "button"`);
                }
            }
            return {
                type: "section",
                text,
                texts,
                accessory,
            };
        }
        case "separator": {
            const spacingRaw = obj.spacing;
            let spacing;
            if (spacingRaw === "small" || spacingRaw === "large") {
                spacing = spacingRaw;
            }
            else if (spacingRaw === 1 || spacingRaw === 2) {
                spacing = spacingRaw;
            }
            else if (spacingRaw !== undefined) {
                throw new Error(`${label}.spacing must be "small", "large", 1, or 2`);
            }
            const divider = typeof obj.divider === "boolean" ? obj.divider : undefined;
            return {
                type: "separator",
                spacing,
                divider,
            };
        }
        case "actions": {
            const buttonsRaw = obj.buttons;
            const buttons = Array.isArray(buttonsRaw)
                ? buttonsRaw.map((entry, idx) => parseButtonSpec(entry, `${label}.buttons[${idx}]`))
                : undefined;
            const select = obj.select ? parseSelectSpec(obj.select, `${label}.select`) : undefined;
            if ((!buttons || buttons.length === 0) && !select) {
                throw new Error(`${label} requires buttons or select`);
            }
            if (buttons && select) {
                throw new Error(`${label} cannot include both buttons and select`);
            }
            return {
                type: "actions",
                buttons,
                select,
            };
        }
        case "media-gallery": {
            const itemsRaw = obj.items;
            if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
                throw new Error(`${label}.items must be a non-empty array`);
            }
            const items = itemsRaw.map((entry, idx) => {
                const itemObj = requireObject(entry, `${label}.items[${idx}]`);
                return {
                    url: readString(itemObj.url, `${label}.items[${idx}].url`),
                    description: readOptionalString(itemObj.description),
                    spoiler: typeof itemObj.spoiler === "boolean" ? itemObj.spoiler : undefined,
                };
            });
            return {
                type: "media-gallery",
                items,
            };
        }
        case "file": {
            const file = readString(obj.file, `${label}.file`);
            return {
                type: "file",
                file: normalizeAttachmentRef(file, `${label}.file`),
                spoiler: typeof obj.spoiler === "boolean" ? obj.spoiler : undefined,
            };
        }
        default:
            throw new Error(`${label}.type must be a supported component block`);
    }
}
export function readDiscordComponentSpec(raw) {
    if (raw === undefined || raw === null) {
        return null;
    }
    const obj = requireObject(raw, "components");
    const blocksRaw = obj.blocks;
    const blocks = Array.isArray(blocksRaw)
        ? blocksRaw.map((entry, idx) => parseComponentBlock(entry, `components.blocks[${idx}]`))
        : undefined;
    const modalRaw = obj.modal;
    const reusable = typeof obj.reusable === "boolean" ? obj.reusable : undefined;
    let modal;
    if (modalRaw !== undefined) {
        const modalObj = requireObject(modalRaw, "components.modal");
        const fieldsRaw = modalObj.fields;
        if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) {
            throw new Error("components.modal.fields must be a non-empty array");
        }
        if (fieldsRaw.length > 5) {
            throw new Error("components.modal.fields supports up to 5 inputs");
        }
        const fields = fieldsRaw.map((entry, idx) => parseModalField(entry, `components.modal.fields[${idx}]`, idx));
        modal = {
            title: readString(modalObj.title, "components.modal.title"),
            triggerLabel: readOptionalString(modalObj.triggerLabel),
            triggerStyle: readOptionalString(modalObj.triggerStyle),
            fields,
        };
    }
    return {
        text: readOptionalString(obj.text),
        reusable,
        container: typeof obj.container === "object" && obj.container && !Array.isArray(obj.container)
            ? {
                accentColor: obj.container.accentColor,
                spoiler: typeof obj.container.spoiler === "boolean"
                    ? obj.container.spoiler
                    : undefined,
            }
            : undefined,
        blocks,
        modal,
    };
}
export function buildDiscordComponentCustomId(params) {
    const base = `${DISCORD_COMPONENT_CUSTOM_ID_KEY}:cid=${params.componentId}`;
    return params.modalId ? `${base};mid=${params.modalId}` : base;
}
export function buildDiscordModalCustomId(modalId) {
    return `${DISCORD_MODAL_CUSTOM_ID_KEY}:mid=${modalId}`;
}
export function parseDiscordComponentCustomId(id) {
    const parsed = parseCustomId(id);
    if (parsed.key !== DISCORD_COMPONENT_CUSTOM_ID_KEY) {
        return null;
    }
    const componentId = parsed.data.cid;
    if (typeof componentId !== "string" || !componentId.trim()) {
        return null;
    }
    const modalId = parsed.data.mid;
    return {
        componentId,
        modalId: typeof modalId === "string" && modalId.trim() ? modalId : undefined,
    };
}
export function parseDiscordModalCustomId(id) {
    const parsed = parseCustomId(id);
    if (parsed.key !== DISCORD_MODAL_CUSTOM_ID_KEY) {
        return null;
    }
    const modalId = parsed.data.mid;
    if (typeof modalId !== "string" || !modalId.trim()) {
        return null;
    }
    return modalId;
}
function isDiscordComponentWildcardRegistrationId(id) {
    return /^__openclaw_discord_component_[a-z_]+_wildcard__$/.test(id);
}
export function parseDiscordComponentCustomIdForCarbon(id) {
    if (id === "*" || isDiscordComponentWildcardRegistrationId(id)) {
        return { key: "*", data: {} };
    }
    const parsed = parseCustomId(id);
    if (parsed.key !== DISCORD_COMPONENT_CUSTOM_ID_KEY) {
        return parsed;
    }
    return { key: "*", data: parsed.data };
}
export function parseDiscordModalCustomIdForCarbon(id) {
    if (id === "*" || isDiscordComponentWildcardRegistrationId(id)) {
        return { key: "*", data: {} };
    }
    const parsed = parseCustomId(id);
    if (parsed.key !== DISCORD_MODAL_CUSTOM_ID_KEY) {
        return parsed;
    }
    return { key: "*", data: parsed.data };
}
function buildTextDisplays(text, texts) {
    if (texts && texts.length > 0) {
        return texts.map((entry) => new TextDisplay(entry));
    }
    if (text) {
        return [new TextDisplay(text)];
    }
    return [];
}
function createButtonComponent(params) {
    const style = mapButtonStyle(params.spec.style);
    const isLink = style === ButtonStyle.Link || Boolean(params.spec.url);
    if (isLink) {
        if (!params.spec.url) {
            throw new Error("Link buttons require a url");
        }
        const linkUrl = params.spec.url;
        class DynamicLinkButton extends LinkButton {
            label = params.spec.label;
            url = linkUrl;
        }
        return { component: new DynamicLinkButton() };
    }
    const componentId = params.componentId ?? createShortId("btn_");
    const customId = buildDiscordComponentCustomId({
        componentId,
        modalId: params.modalId,
    });
    class DynamicButton extends Button {
        label = params.spec.label;
        customId = customId;
        style = style;
        emoji = params.spec.emoji;
        disabled = params.spec.disabled ?? false;
    }
    return {
        component: new DynamicButton(),
        entry: {
            id: componentId,
            kind: params.modalId ? "modal-trigger" : "button",
            label: params.spec.label,
            modalId: params.modalId,
            allowedUsers: params.spec.allowedUsers,
        },
    };
}
function createSelectComponent(params) {
    const type = (params.spec.type ?? "string").toLowerCase();
    const componentId = params.componentId ?? createShortId("sel_");
    const customId = buildDiscordComponentCustomId({ componentId });
    if (type === "string") {
        const options = params.spec.options ?? [];
        if (options.length === 0) {
            throw new Error("String select menus require options");
        }
        class DynamicStringSelect extends StringSelectMenu {
            customId = customId;
            options = options;
            minValues = params.spec.minValues;
            maxValues = params.spec.maxValues;
            placeholder = params.spec.placeholder;
            disabled = false;
        }
        return {
            component: new DynamicStringSelect(),
            entry: {
                id: componentId,
                kind: "select",
                label: params.spec.placeholder ?? "select",
                selectType: "string",
                options: options.map((option) => ({ value: option.value, label: option.label })),
            },
        };
    }
    if (type === "user") {
        class DynamicUserSelect extends UserSelectMenu {
            customId = customId;
            minValues = params.spec.minValues;
            maxValues = params.spec.maxValues;
            placeholder = params.spec.placeholder;
            disabled = false;
        }
        return {
            component: new DynamicUserSelect(),
            entry: {
                id: componentId,
                kind: "select",
                label: params.spec.placeholder ?? "user select",
                selectType: "user",
            },
        };
    }
    if (type === "role") {
        class DynamicRoleSelect extends RoleSelectMenu {
            customId = customId;
            minValues = params.spec.minValues;
            maxValues = params.spec.maxValues;
            placeholder = params.spec.placeholder;
            disabled = false;
        }
        return {
            component: new DynamicRoleSelect(),
            entry: {
                id: componentId,
                kind: "select",
                label: params.spec.placeholder ?? "role select",
                selectType: "role",
            },
        };
    }
    if (type === "mentionable") {
        class DynamicMentionableSelect extends MentionableSelectMenu {
            customId = customId;
            minValues = params.spec.minValues;
            maxValues = params.spec.maxValues;
            placeholder = params.spec.placeholder;
            disabled = false;
        }
        return {
            component: new DynamicMentionableSelect(),
            entry: {
                id: componentId,
                kind: "select",
                label: params.spec.placeholder ?? "mentionable select",
                selectType: "mentionable",
            },
        };
    }
    class DynamicChannelSelect extends ChannelSelectMenu {
        customId = customId;
        minValues = params.spec.minValues;
        maxValues = params.spec.maxValues;
        placeholder = params.spec.placeholder;
        disabled = false;
    }
    return {
        component: new DynamicChannelSelect(),
        entry: {
            id: componentId,
            kind: "select",
            label: params.spec.placeholder ?? "channel select",
            selectType: "channel",
        },
    };
}
function isSelectComponent(component) {
    return (component instanceof StringSelectMenu ||
        component instanceof UserSelectMenu ||
        component instanceof RoleSelectMenu ||
        component instanceof MentionableSelectMenu ||
        component instanceof ChannelSelectMenu);
}
function createModalFieldComponent(field) {
    if (field.type === "text") {
        class DynamicTextInput extends TextInput {
            customId = field.id;
            style = mapTextInputStyle(field.style);
            placeholder = field.placeholder;
            required = field.required;
            minLength = field.minLength;
            maxLength = field.maxLength;
        }
        return new DynamicTextInput();
    }
    if (field.type === "select") {
        const options = field.options ?? [];
        class DynamicModalSelect extends StringSelectMenu {
            customId = field.id;
            options = options;
            required = field.required;
            minValues = field.minValues;
            maxValues = field.maxValues;
            placeholder = field.placeholder;
        }
        return new DynamicModalSelect();
    }
    if (field.type === "role-select") {
        class DynamicModalRoleSelect extends RoleSelectMenu {
            customId = field.id;
            required = field.required;
            minValues = field.minValues;
            maxValues = field.maxValues;
            placeholder = field.placeholder;
        }
        return new DynamicModalRoleSelect();
    }
    if (field.type === "user-select") {
        class DynamicModalUserSelect extends UserSelectMenu {
            customId = field.id;
            required = field.required;
            minValues = field.minValues;
            maxValues = field.maxValues;
            placeholder = field.placeholder;
        }
        return new DynamicModalUserSelect();
    }
    if (field.type === "checkbox") {
        const options = field.options ?? [];
        class DynamicCheckboxGroup extends CheckboxGroup {
            customId = field.id;
            options = options;
            required = field.required;
            minValues = field.minValues;
            maxValues = field.maxValues;
        }
        return new DynamicCheckboxGroup();
    }
    const options = field.options ?? [];
    class DynamicRadioGroup extends RadioGroup {
        customId = field.id;
        options = options;
        required = field.required;
        minValues = field.minValues;
        maxValues = field.maxValues;
    }
    return new DynamicRadioGroup();
}
export function buildDiscordComponentMessage(params) {
    const entries = [];
    const modals = [];
    const components = [];
    const containerChildren = [];
    const addEntry = (entry) => {
        entries.push({
            ...entry,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            accountId: params.accountId,
            reusable: entry.reusable ?? params.spec.reusable,
        });
    };
    const text = params.spec.text ?? params.fallbackText;
    if (text) {
        containerChildren.push(new TextDisplay(text));
    }
    for (const block of params.spec.blocks ?? []) {
        if (block.type === "text") {
            containerChildren.push(new TextDisplay(block.text));
            continue;
        }
        if (block.type === "section") {
            const displays = buildTextDisplays(block.text, block.texts);
            if (displays.length > 3) {
                throw new Error("Section blocks support up to 3 text displays");
            }
            let accessory;
            if (block.accessory?.type === "thumbnail") {
                accessory = new Thumbnail(block.accessory.url);
            }
            else if (block.accessory?.type === "button") {
                const { component, entry } = createButtonComponent({ spec: block.accessory.button });
                accessory = component;
                if (entry) {
                    addEntry(entry);
                }
            }
            containerChildren.push(new Section(displays, accessory));
            continue;
        }
        if (block.type === "separator") {
            containerChildren.push(new Separator({ spacing: block.spacing, divider: block.divider }));
            continue;
        }
        if (block.type === "media-gallery") {
            containerChildren.push(new MediaGallery(block.items));
            continue;
        }
        if (block.type === "file") {
            containerChildren.push(new File(block.file, block.spoiler));
            continue;
        }
        if (block.type === "actions") {
            const rowComponents = [];
            if (block.buttons) {
                if (block.buttons.length > 5) {
                    throw new Error("Action rows support up to 5 buttons");
                }
                for (const button of block.buttons) {
                    const { component, entry } = createButtonComponent({ spec: button });
                    rowComponents.push(component);
                    if (entry) {
                        addEntry(entry);
                    }
                }
            }
            else if (block.select) {
                const { component, entry } = createSelectComponent({ spec: block.select });
                rowComponents.push(component);
                addEntry(entry);
            }
            containerChildren.push(new Row(rowComponents));
        }
    }
    if (params.spec.modal) {
        const modalId = createShortId("mdl_");
        const fields = params.spec.modal.fields.map((field, index) => ({
            id: createShortId("fld_"),
            name: normalizeModalFieldName(field.name, index),
            label: field.label,
            type: field.type,
            description: field.description,
            placeholder: field.placeholder,
            required: field.required,
            options: field.options,
            minValues: field.minValues,
            maxValues: field.maxValues,
            minLength: field.minLength,
            maxLength: field.maxLength,
            style: field.style,
        }));
        modals.push({
            id: modalId,
            title: params.spec.modal.title,
            fields,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            accountId: params.accountId,
            reusable: params.spec.reusable,
        });
        const triggerSpec = {
            label: params.spec.modal.triggerLabel ?? "Open form",
            style: params.spec.modal.triggerStyle ?? "primary",
        };
        const { component, entry } = createButtonComponent({
            spec: triggerSpec,
            modalId,
        });
        if (entry) {
            addEntry(entry);
        }
        const lastChild = containerChildren.at(-1);
        if (lastChild instanceof Row) {
            const row = lastChild;
            const hasSelect = row.components.some((entry) => isSelectComponent(entry));
            if (row.components.length < 5 && !hasSelect) {
                row.addComponent(component);
            }
            else {
                containerChildren.push(new Row([component]));
            }
        }
        else {
            containerChildren.push(new Row([component]));
        }
    }
    if (containerChildren.length === 0) {
        throw new Error("components must include at least one block, text, or modal trigger");
    }
    const container = new Container(containerChildren, params.spec.container);
    components.push(container);
    return { components, entries, modals };
}
export function buildDiscordComponentMessageFlags(components) {
    const hasV2 = components.some((component) => component.isV2);
    return hasV2 ? MessageFlags.IsComponentsV2 : undefined;
}
export class DiscordFormModal extends Modal {
    title;
    customId;
    components;
    customIdParser = parseDiscordModalCustomIdForCarbon;
    constructor(params) {
        super();
        this.title = params.title;
        this.customId = buildDiscordModalCustomId(params.modalId);
        this.components = params.fields.map((field) => {
            const component = createModalFieldComponent(field);
            class DynamicLabel extends Label {
                label = field.label;
                description = field.description;
                component = component;
                customId = field.id;
            }
            return new DynamicLabel(component);
        });
    }
    async run() {
        throw new Error("Modal handler is not registered for dynamic forms");
    }
}
export function createDiscordFormModal(entry) {
    return new DiscordFormModal({
        modalId: entry.id,
        title: entry.title,
        fields: entry.fields,
    });
}
export function formatDiscordComponentEventText(params) {
    if (params.kind === "button") {
        return `Clicked "${params.label}".`;
    }
    const values = params.values ?? [];
    if (values.length === 0) {
        return `Updated "${params.label}".`;
    }
    return `Selected ${values.join(", ")} from "${params.label}".`;
}
