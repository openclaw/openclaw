export function createLazyRuntimeSurface(importer, select) {
    let cached = null;
    return () => {
        cached ??= importer().then(select);
        return cached;
    };
}
/** Cache the raw dynamically imported runtime module behind a stable loader. */
export function createLazyRuntimeModule(importer) {
    return createLazyRuntimeSurface(importer, (module) => module);
}
/** Cache a single named runtime export without repeating a custom selector closure per caller. */
export function createLazyRuntimeNamedExport(importer, key) {
    return createLazyRuntimeSurface(importer, (module) => module[key]);
}
export function createLazyRuntimeMethod(load, select) {
    const invoke = async (...args) => {
        const method = select(await load());
        return await method(...args);
    };
    return invoke;
}
export function createLazyRuntimeMethodBinder(load) {
    return function (select) {
        return createLazyRuntimeMethod(load, select);
    };
}
