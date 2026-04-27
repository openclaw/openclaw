import { confirm as clackConfirm, intro as clackIntro, outro as clackOutro, select as clackSelect, text as clackText, } from "@clack/prompts";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
export const CONFIGURE_WIZARD_SECTIONS = [
    "workspace",
    "model",
    "web",
    "gateway",
    "daemon",
    "channels",
    "plugins",
    "skills",
    "health",
];
export function parseConfigureWizardSections(raw) {
    const sectionsRaw = Array.isArray(raw) ? normalizeStringEntries(raw) : [];
    if (sectionsRaw.length === 0) {
        return { sections: [], invalid: [] };
    }
    const invalid = sectionsRaw.filter((s) => !CONFIGURE_WIZARD_SECTIONS.includes(s));
    const sections = sectionsRaw.filter((s) => CONFIGURE_WIZARD_SECTIONS.includes(s));
    return { sections, invalid };
}
export const CONFIGURE_SECTION_OPTIONS = [
    { value: "workspace", label: "Workspace", hint: "Set workspace + sessions" },
    { value: "model", label: "Model", hint: "Pick provider + credentials" },
    { value: "web", label: "Web tools", hint: "Configure web search (Perplexity/Brave) + fetch" },
    { value: "gateway", label: "Gateway", hint: "Port, bind, auth, tailscale" },
    {
        value: "daemon",
        label: "Daemon",
        hint: "Install/manage the background service",
    },
    {
        value: "channels",
        label: "Channels",
        hint: "Link WhatsApp/Telegram/etc and defaults",
    },
    { value: "plugins", label: "Plugins", hint: "Configure plugin settings (sandbox, tools, etc.)" },
    { value: "skills", label: "Skills", hint: "Install/enable workspace skills" },
    {
        value: "health",
        label: "Health check",
        hint: "Run gateway + channel checks",
    },
];
export const intro = (message) => clackIntro(stylePromptTitle(message) ?? message);
export const outro = (message) => clackOutro(stylePromptTitle(message) ?? message);
export const text = (params) => clackText({
    ...params,
    message: stylePromptMessage(params.message),
});
export const confirm = (params) => clackConfirm({
    ...params,
    message: stylePromptMessage(params.message),
});
export const select = (params) => clackSelect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) => opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) }),
});
