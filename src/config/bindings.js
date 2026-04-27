function normalizeBindingType(binding) {
    return binding.type === "acp" ? "acp" : "route";
}
export function isRouteBinding(binding) {
    return normalizeBindingType(binding) === "route";
}
export function isAcpBinding(binding) {
    return normalizeBindingType(binding) === "acp";
}
export function listConfiguredBindings(cfg) {
    return Array.isArray(cfg.bindings) ? cfg.bindings : [];
}
export function listRouteBindings(cfg) {
    return listConfiguredBindings(cfg).filter(isRouteBinding);
}
export function listAcpBindings(cfg) {
    return listConfiguredBindings(cfg).filter(isAcpBinding);
}
