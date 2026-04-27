export function sortFlowContributionsByLabel(contributions) {
    return [...contributions].toSorted((left, right) => left.option.label.localeCompare(right.option.label) ||
        left.option.value.localeCompare(right.option.value));
}
