import { buildAuthChoiceGroups } from "./auth-choice-options.js";
const BACK_VALUE = "__back";
export async function promptAuthChoiceGrouped(params) {
    const { groups, skipOption } = buildAuthChoiceGroups(params);
    const availableGroups = groups.filter((group) => group.options.length > 0);
    while (true) {
        const providerOptions = [
            ...availableGroups.map((group) => ({
                value: group.value,
                label: group.label,
                hint: group.hint,
            })),
            ...(skipOption ? [skipOption] : []),
        ];
        const providerSelection = (await params.prompter.select({
            message: "Model/auth provider",
            options: providerOptions,
            searchable: true,
        }));
        if (providerSelection === "skip") {
            return "skip";
        }
        const group = availableGroups.find((candidate) => candidate.value === providerSelection);
        if (!group || group.options.length === 0) {
            await params.prompter.note("No auth methods available for that provider.", "Model/auth choice");
            continue;
        }
        if (group.options.length === 1) {
            return group.options[0].value;
        }
        const methodSelection = await params.prompter.select({
            message: `${group.label} auth method`,
            options: [...group.options, { value: BACK_VALUE, label: "Back" }],
        });
        if (methodSelection === BACK_VALUE) {
            continue;
        }
        return methodSelection;
    }
}
