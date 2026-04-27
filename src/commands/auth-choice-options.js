import { resolveProviderSetupFlowContributions } from "../flows/provider-flow.js";
import { CORE_AUTH_CHOICE_OPTIONS, formatStaticAuthChoiceChoicesForCli, } from "./auth-choice-options.static.js";
function compareOptionLabels(a, b) {
    return a.label.localeCompare(b.label);
}
function compareAssistantOptions(a, b) {
    const priorityA = a.assistantPriority ?? 0;
    const priorityB = b.assistantPriority ?? 0;
    return priorityA - priorityB || compareOptionLabels(a, b);
}
function compareGroupLabels(a, b) {
    return a.label.localeCompare(b.label);
}
function resolveProviderChoiceOptions(params) {
    return resolveProviderSetupFlowContributions({
        ...params,
        scope: "text-inference",
    }).map((contribution) => Object.assign({}, { value: contribution.option.value, label: contribution.option.label }, contribution.option.hint ? { hint: contribution.option.hint } : {}, contribution.option.assistantPriority !== undefined
        ? { assistantPriority: contribution.option.assistantPriority }
        : {}, contribution.option.assistantVisibility
        ? { assistantVisibility: contribution.option.assistantVisibility }
        : {}, contribution.option.group
        ? {
            groupId: contribution.option.group.id,
            groupLabel: contribution.option.group.label,
            ...(contribution.option.group.hint
                ? { groupHint: contribution.option.group.hint }
                : {}),
        }
        : {}));
}
export function formatAuthChoiceChoicesForCli(params) {
    const values = [
        ...formatStaticAuthChoiceChoicesForCli(params).split("|"),
        ...resolveProviderSetupFlowContributions({
            ...params,
            scope: "text-inference",
        }).map((contribution) => contribution.option.value),
    ];
    return [...new Set(values)].join("|");
}
export function buildAuthChoiceOptions(params) {
    void params.store;
    const optionByValue = new Map();
    for (const option of CORE_AUTH_CHOICE_OPTIONS) {
        optionByValue.set(option.value, option);
    }
    for (const option of resolveProviderChoiceOptions({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
    })) {
        optionByValue.set(option.value, option);
    }
    const options = Array.from(optionByValue.values())
        .toSorted(compareOptionLabels)
        .filter((option) => params.assistantVisibleOnly ? option.assistantVisibility !== "manual-only" : true);
    if (params.includeSkip) {
        options.push({ value: "skip", label: "Skip for now" });
    }
    return options;
}
export function buildAuthChoiceGroups(params) {
    const options = buildAuthChoiceOptions({
        ...params,
        includeSkip: false,
        assistantVisibleOnly: true,
    });
    const groupsById = new Map();
    for (const option of options) {
        if (!option.groupId || !option.groupLabel) {
            continue;
        }
        const existing = groupsById.get(option.groupId);
        if (existing) {
            existing.options.push(option);
            continue;
        }
        groupsById.set(option.groupId, {
            value: option.groupId,
            label: option.groupLabel,
            ...(option.groupHint ? { hint: option.groupHint } : {}),
            options: [option],
        });
    }
    const groups = Array.from(groupsById.values())
        .map((group) => Object.assign({}, group, { options: [...group.options].toSorted(compareAssistantOptions) }))
        .toSorted(compareGroupLabels);
    const skipOption = params.includeSkip
        ? { value: "skip", label: "Skip for now" }
        : undefined;
    return { groups, skipOption };
}
