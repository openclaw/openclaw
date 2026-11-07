import Module from "node:module";
import path from "node:path";

type Options = {
  modulePath: (filename: string) => string;
  isMember: (filename: string) => boolean;
  hostCache: NodeJS.Dict<NodeJS.Module>;
  readJson: (filename: string) => unknown;
};

/** Source-facing cache mutations affect only one snapshot instance's require evaluations. */
export function createPluginSnapshotRequireCache(options: Options) {
  const entries: NodeJS.Dict<NodeJS.Module> = Object.create(null);
  const paths = new Map<string, string>();
  const pending = new Set<string>();
  const json = new Map<string, unknown>();
  const cacheKey = (key: string | symbol) => {
    if (typeof key !== "string" || !path.isAbsolute(key)) {
      return key;
    }
    const filename = options.modulePath(key);
    return options.isMember(filename) ? filename : key;
  };
  const cache: NodeJS.Dict<NodeJS.Module> = new Proxy(entries, {
    get(values, property, receiver) {
      const key = cacheKey(property);
      const filename = typeof key === "string" ? paths.get(key) : undefined;
      return filename ? options.hostCache[filename] : Reflect.get(values, key, receiver);
    },
    set(values, property, value: unknown) {
      const key = cacheKey(property);
      if (!Reflect.set(values, key, value)) {
        return false;
      }
      if (typeof key === "string") {
        const filename = paths.get(key);
        if (filename) {
          Reflect.set(options.hostCache, filename, value);
        } else {
          pending.add(key);
        }
        json.delete(key);
      }
      return true;
    },
    deleteProperty(values, property) {
      const key = cacheKey(property);
      if (!Reflect.deleteProperty(values, key)) {
        return false;
      }
      if (typeof key === "string") {
        const filename = paths.get(key);
        if (filename) {
          delete options.hostCache[filename];
        }
        pending.delete(key);
        json.delete(key);
      }
      return true;
    },
  });
  const jsonValue = (filename: string, key: string) => {
    if (!json.has(key)) {
      json.set(key, options.readJson(filename));
    }
    return json.get(key);
  };
  return {
    cache,
    entries,
    injected: (key: string) => (pending.has(key) ? entries[key] : undefined),
    load<T>(key: string, filename: string, evaluate: () => T): T {
      paths.set(key, filename);
      if (pending.delete(key)) {
        options.hostCache[filename] = entries[key];
      }
      try {
        return evaluate();
      } finally {
        const entry = options.hostCache[filename];
        if (entry) {
          entries[key] = entry;
        } else {
          delete entries[key];
        }
      }
    },
    jsonValue,
    jsonModule(filename: string, key: string) {
      let entry = entries[key];
      if (!entry) {
        entry = new Module(key);
        entry.filename = filename;
        entry.exports = jsonValue(filename, key);
        entry.loaded = true;
        entries[key] = entry;
      }
      return entry.exports;
    },
    clear() {
      json.clear();
      paths.clear();
      pending.clear();
      for (const filename of Reflect.ownKeys(entries)) {
        Reflect.deleteProperty(entries, filename);
      }
    },
  };
}
