type NativeErrorValue = NativeWorkerError | { kind: "value"; value: unknown };

type NativeWorkerError = {
  kind: "error";
  constructorName: string;
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  errcode?: number;
  errno?: number;
  cause?: NativeErrorValue;
  errors?: NativeErrorValue[];
  error?: NativeErrorValue;
  suppressed?: NativeErrorValue;
};

export type NativeWorkerFailure = NativeErrorValue;

const errorConstructors = new Map<string, new (message: string) => Error>(
  [EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, Error].map(
    (constructor) => [constructor.name, constructor],
  ),
);

/** Node's Worker error events use prototype-only Errors that a second clone would erase. */
export function encodeNativeWorkerFailure(value: unknown): NativeWorkerFailure {
  const seen = new Map<Error, NativeWorkerError>();
  const encode = (current: unknown): NativeErrorValue => {
    if (!(current instanceof Error)) {
      return { kind: "value", value: current };
    }
    const prior = seen.get(current);
    if (prior) {
      return prior;
    }
    const node: NativeWorkerError = {
      kind: "error",
      constructorName:
        current instanceof AggregateError
          ? "AggregateError"
          : current instanceof SuppressedError
            ? "SuppressedError"
            : ([...errorConstructors].find(
                ([, Constructor]) => current instanceof Constructor,
              )?.[0] ?? "Error"),
      name: current.name,
      message: current.message,
      stack: current.stack,
    };
    seen.set(current, node);
    const code: unknown = Object.getOwnPropertyDescriptor(current, "code")?.value;
    if (typeof code === "string" || typeof code === "number") {
      node.code = code;
    }
    for (const key of ["errcode", "errno"] as const) {
      const field: unknown = Object.getOwnPropertyDescriptor(current, key)?.value;
      if (typeof field === "number") {
        node[key] = field;
      }
    }
    if (Object.hasOwn(current, "cause")) {
      node.cause = encode(current.cause);
    }
    // Node reconstructs AggregateError with Error.prototype while retaining its errors field.
    const errors: unknown = Object.getOwnPropertyDescriptor(current, "errors")?.value;
    if (Array.isArray(errors)) {
      node.errors = errors.map(encode);
    }
    // Downlevel async disposal uses a named Error with the same two failure fields.
    if (current instanceof SuppressedError || current.name === "SuppressedError") {
      for (const key of ["error", "suppressed"] as const) {
        const field = Object.getOwnPropertyDescriptor(current, key);
        if (field && "value" in field) {
          node[key] = encode(field.value);
        }
      }
    }
    return node;
  };
  return encode(value);
}

export function decodeNativeWorkerFailure(value: NativeWorkerFailure): unknown {
  const seen = new Map<NativeWorkerError, Error>();
  const decode = (current: NativeErrorValue): unknown => {
    if (current.kind === "value") {
      return current.value;
    }
    const prior = seen.get(current);
    if (prior) {
      return prior;
    }
    const Constructor = errorConstructors.get(current.constructorName) ?? Error;
    const error =
      current.constructorName === "AggregateError"
        ? new AggregateError([], current.message)
        : current.constructorName === "SuppressedError"
          ? new SuppressedError(undefined, undefined, current.message)
          : new Constructor(current.message);
    seen.set(current, error);
    error.name = current.name;
    error.stack = current.stack;
    const defineField = (key: string, fieldValue: unknown, enumerable = false) => {
      Object.defineProperty(error, key, {
        value: fieldValue,
        writable: true,
        configurable: true,
        enumerable,
      });
    };
    for (const key of ["code", "errcode", "errno"] as const) {
      if (current[key] !== undefined) {
        defineField(key, current[key], true);
      }
    }
    if (current.cause) {
      defineField("cause", decode(current.cause));
    }
    if (current.errors) {
      defineField("errors", current.errors.map(decode));
    }
    for (const key of ["error", "suppressed"] as const) {
      const failure = current[key];
      if (failure) {
        defineField(key, decode(failure));
      }
    }
    return error;
  };
  return decode(value);
}
