type OwnedValueState<TInstance extends object> = {
  instance?: TInstance;
  originalInstance?: TInstance;
  original?: object;
};

// oxlint-disable-next-line typescript/no-extraneous-class -- Derived classes need a returning base constructor to stamp private fields on an existing object.
export class PluginHostObject {
  constructor(value: object) {
    // oxlint-disable-next-line eslint/no-constructor-return -- Derived private fields must be stamped on the host object without changing its prototype.
    return value;
  }
}

export class PluginCallToken extends PluginHostObject {
  #hostCleanup: boolean;

  constructor(value: object, hostCleanup: boolean) {
    super(value);
    this.#hostCleanup = hostCleanup;
  }

  static isHostCleanup(token: object): boolean {
    return #hostCleanup in token && token.#hostCleanup;
  }
}

/** Installed once in the shared instance singleton, including its private-field brand. */
export function createPluginValueInstances<TInstance extends object>() {
  // Private fields are installed on the returned object without invoking Proxy traps.
  // They cannot be discovered through reflection or forwarded by a foreign Proxy.
  class OwnedValue extends PluginHostObject {
    #state: OwnedValueState<TInstance>;

    constructor(value: object, state: OwnedValueState<TInstance>) {
      super(value);
      this.#state = state;
    }

    static get(value: unknown): OwnedValueState<TInstance> | undefined {
      if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        return undefined;
      }
      return #state in value ? value.#state : undefined;
    }
  }

  const foreign = new WeakMap<object, TInstance>();
  const install = (value: object): OwnedValueState<TInstance> => {
    const current = OwnedValue.get(value);
    if (current) {
      return current;
    }
    const state: OwnedValueState<TInstance> = { instance: foreign.get(value) };
    if (state.instance) {
      foreign.delete(value);
    }
    void new OwnedValue(value, state);
    return state;
  };
  return {
    get(value: object): TInstance | undefined {
      return OwnedValue.get(value)?.instance ?? foreign.get(value);
    },
    set(value: object, instance: TInstance) {
      const owned = OwnedValue.get(value);
      if (owned) {
        owned.instance = instance;
      } else {
        foreign.set(value, instance);
      }
      return this;
    },
    setHost(value: object, instance: TInstance) {
      install(value).instance = instance;
      return this;
    },
    getOriginal(value: object, instance: TInstance): object | undefined {
      const owned = OwnedValue.get(value);
      return owned?.originalInstance === instance ? owned.original : undefined;
    },
    setOriginal(value: object, original: object, instance: TInstance): void {
      const owned = install(value);
      owned.originalInstance = instance;
      owned.original = original;
    },
  };
}
