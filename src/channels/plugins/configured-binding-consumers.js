const registeredConfiguredBindingConsumers = new Map();
export function listConfiguredBindingConsumers() {
    return [...registeredConfiguredBindingConsumers.values()];
}
export function resolveConfiguredBindingConsumer(binding) {
    for (const consumer of listConfiguredBindingConsumers()) {
        if (consumer.supports(binding)) {
            return consumer;
        }
    }
    return null;
}
export function registerConfiguredBindingConsumer(consumer) {
    const id = consumer.id.trim();
    if (!id) {
        throw new Error("Configured binding consumer id is required");
    }
    const existing = registeredConfiguredBindingConsumers.get(id);
    if (existing) {
        return;
    }
    registeredConfiguredBindingConsumers.set(id, {
        ...consumer,
        id,
    });
}
export function unregisterConfiguredBindingConsumer(id) {
    registeredConfiguredBindingConsumers.delete(id.trim());
}
