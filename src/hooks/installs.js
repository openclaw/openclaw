export function recordHookInstall(cfg, update) {
    const { hookId, ...record } = update;
    const installs = {
        ...cfg.hooks?.internal?.installs,
        [hookId]: {
            ...cfg.hooks?.internal?.installs?.[hookId],
            ...record,
            installedAt: record.installedAt ?? new Date().toISOString(),
        },
    };
    return {
        ...cfg,
        hooks: {
            ...cfg.hooks,
            internal: {
                ...cfg.hooks?.internal,
                installs: {
                    ...installs,
                    [hookId]: installs[hookId],
                },
            },
        },
    };
}
