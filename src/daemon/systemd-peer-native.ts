/** Typed private-peer reads through the platform sd-bus ABI, not a D-Bus codec. */
import { createRequire } from "node:module";
import { getProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";
import { createSystemdPeerQueue } from "./systemd-peer-queue.js";

const require = createRequire(import.meta.url);
type Pointer = object | null;
type NativeFunction = { (...args: unknown[]): number; async: (...args: unknown[]) => void };
const unavailable = () => new Error("Original systemd manager peer inspection is unavailable.");
const checked = (result: number) => {
  if (result < 0) {
    throw unavailable();
  }
  return result;
};
const invoke = (fn: NativeFunction, ...args: unknown[]): Promise<number> =>
  new Promise((resolve, reject) => {
    fn.async(...args, (error: Error | null, result: number) => {
      if (error) {
        reject(error);
      } else {
        try {
          resolve(checked(result));
        } catch (failure) {
          reject(failure instanceof Error ? failure : unavailable());
        }
      }
    });
  });

export type SystemdPeerIdentity = { uid: number; pid: number; startTime: number };

function loadApi() {
  // SAFETY: Koffi's require export matches its typed default export.
  const koffi = require("koffi") as typeof import("koffi").default;
  const library = koffi.load("libsystemd.so.0");
  const bind = (declaration: string): NativeFunction => library.func(declaration);
  return {
    koffi,
    errorSize: koffi.sizeof(koffi.struct({ name: "void *", message: "void *", needFree: "int" })),
    errorHasName: bind("int sd_bus_error_has_name(void *error, const char *name)"),
    errorFree: bind("void sd_bus_error_free(void *error)"),
    newBus: bind("int sd_bus_new(_Out_ void **bus)"),
    address: bind("int sd_bus_set_address(void *bus, const char *address)"),
    client: bind("int sd_bus_set_bus_client(void *bus, int client)"),
    start: bind("int sd_bus_start(void *bus)"),
    ready: bind("int sd_bus_is_ready(void *bus)"),
    process: bind("int sd_bus_process(void *bus, void *message)"),
    wait: bind("int sd_bus_wait(void *bus, uint64_t timeout)"),
    timeout: bind("int sd_bus_set_method_call_timeout(void *bus, uint64_t timeout)"),
    credentials: bind("int sd_bus_get_owner_creds(void *bus, uint64_t mask, _Out_ void **creds)"),
    pid: bind("int sd_bus_creds_get_pid(void *creds, _Out_ int *pid)"),
    uid: bind("int sd_bus_creds_get_euid(void *creds, _Out_ uint32_t *uid)"),
    unrefCredentials: bind("void *sd_bus_creds_unref(void *creds)"),
    property: bind(
      "int sd_bus_get_property(void *bus, const char *destination, const char *path, const char *interface, const char *member, void *error, _Out_ void **reply, const char *type)",
    ),
    newCall: bind(
      "int sd_bus_message_new_method_call(void *bus, _Out_ void **message, const char *destination, const char *path, const char *interface, const char *member)",
    ),
    append: bind("int sd_bus_message_append_basic(void *message, char type, const char *value)"),
    autoStart: bind("int sd_bus_message_set_auto_start(void *message, int auto_start)"),
    call: bind(
      "int sd_bus_call(void *bus, void *message, uint64_t timeout, void *error, _Out_ void **reply)",
    ),
    basic: bind("int sd_bus_message_read_basic(void *message, char type, void *value)"),
    enter: bind(
      "int sd_bus_message_enter_container(void *message, char type, const char *contents)",
    ),
    exit: bind("int sd_bus_message_exit_container(void *message)"),
    end: bind("int sd_bus_message_at_end(void *message, int complete)"),
    unrefMessage: bind("void *sd_bus_message_unref(void *message)"),
    close: bind("void *sd_bus_close_unref(void *bus)"),
  };
}
let api: ReturnType<typeof loadApi> | undefined;

/** The caller already authenticated this exact manager through its selected broker. */
export async function openSystemdPrivatePeer(
  address: string,
  expected: SystemdPeerIdentity,
  deadline: number,
) {
  return await openSystemdConnection(address, deadline, expected);
}

/** One broker connection: unique names never cross a reconnect or route fallback. */
export async function openSystemdBroker(address: string, deadline: number) {
  return await openSystemdConnection(address, deadline);
}

async function openSystemdConnection(
  address: string,
  deadline: number,
  expected?: SystemdPeerIdentity,
) {
  assertGatewayServiceUpdateCurrent();
  const native = (api ??= loadApi());
  const output: Pointer[] = [null];
  checked(native.newBus(output));
  const bus = output[0];
  let closed = false;
  const queue = createSystemdPeerQueue();
  let closing: Promise<void> | undefined;
  const remaining = (until: number) => {
    assertGatewayServiceUpdateCurrent();
    const value = until - performance.now();
    if (closed || value <= 0) {
      throw unavailable();
    }
    return Math.max(1, Math.floor(value * 1000));
  };
  const close = () => {
    closed = true;
    return (closing ??= queue.drain().then(() => {
      native.close(bus);
    }));
  };
  const verify = () => {
    assertGatewayServiceUpdateCurrent();
    if (
      closed ||
      (expected &&
        (!isPidAlive(expected.pid) || getProcessStartTime(expected.pid) !== expected.startTime))
    ) {
      throw unavailable();
    }
  };
  // Only call while owning the native queue (or before admission is published).
  const verifyConnection = () => {
    verify();
    if (!expected) {
      return;
    }
    const credentials: Pointer[] = [null];
    // No AUGMENT: these are kernel credentials of THIS connected private peer.
    checked(native.credentials(bus, 17, credentials)); // PID | EUID, stable sd-bus ABI.
    try {
      const pid = [0],
        uid = [0];
      checked(native.pid(credentials[0], pid));
      checked(native.uid(credentials[0], uid));
      if (
        pid[0] !== expected.pid ||
        uid[0] !== expected.uid ||
        getProcessStartTime(expected.pid) !== expected.startTime
      ) {
        throw unavailable();
      }
    } finally {
      native.unrefCredentials(credentials[0]);
    }
  };
  try {
    checked(native.address(bus, address));
    checked(native.client(bus, expected ? 0 : 1));
    remaining(deadline);
    await invoke(native.start, bus);
    // Drive only authentication. No property read or service activation precedes credentials.
    while (!checked(native.ready(bus))) {
      remaining(deadline);
      if (!(await invoke(native.process, bus, null))) {
        await invoke(native.wait, bus, remaining(deadline));
      }
    }
    remaining(deadline);
    verifyConnection();
  } catch (error) {
    await close();
    throw error;
  }

  // These are the existing inspectors' finite property signatures. sd-bus owns
  // wire decoding; we only copy validated values/containers into their JS shape.
  const structs: Record<string, string[]> = {
    "(sb)": ["s", "b"],
    "(sus)": ["s", "u", "s"],
    "(sasbttttuii)": ["s", "as", "b", "t", "t", "t", "t", "u", "i", "i"],
  };
  const scalar: Record<string, string> = {
    s: "str",
    o: "str",
    u: "uint32_t",
    i: "int32_t",
    t: "uint64_t",
    b: "int32_t",
  };
  const read = (
    message: Pointer | undefined,
    signature: string | undefined,
    budget: { values: number; bytes: number },
  ): unknown => {
    if (!message || !signature || --budget.values < 0) {
      throw unavailable();
    }
    if (signature.startsWith("a")) {
      checked(native.enter(message, 97, signature.slice(1)));
      const values = [];
      while (!checked(native.end(message, 0))) {
        values.push(read(message, signature.slice(1), budget));
      }
      checked(native.exit(message));
      return values;
    }
    const fields = structs[signature];
    if (fields) {
      checked(native.enter(message, 114, signature.slice(1, -1)));
      const values = fields.map((field) => read(message, field, budget));
      if (!checked(native.end(message, 0))) {
        throw unavailable();
      }
      checked(native.exit(message));
      return values;
    }
    const type = scalar[signature];
    if (!type) {
      throw unavailable();
    }
    const bytes = Buffer.alloc(8);
    if (checked(native.basic(message, signature.charCodeAt(0), bytes)) !== 1) {
      throw unavailable();
    }
    const value: unknown = native.koffi.decode(bytes, type);
    if (typeof value === "string") {
      budget.bytes -= Buffer.byteLength(value);
      if (budget.bytes < 0) {
        throw unavailable();
      }
    }
    if (signature === "b") {
      if (value !== 0 && value !== 1) {
        throw unavailable();
      }
      return value === 1;
    }
    // Match busctl JSON's numeric representation; existing readers reject
    // unsafe counters rather than confusing UINT64_MAX with a drained unit.
    return typeof value === "bigint" ? Number(value) : value;
  };
  const execute = async (
    args: string[],
    signatures: string[],
    until: number,
    assertCurrent?: () => void,
  ) => {
    const check = () => {
      remaining(until);
      assertCurrent?.();
      verifyConnection();
    };
    check();
    const member = args[4];
    if (!member) {
      throw unavailable();
    }
    const values: unknown[] = [];
    const budget = { values: 16384, bytes: 1024 * 1024 };
    if (args[0] === "get-property") {
      if (args.length - 4 !== signatures.length) {
        throw unavailable();
      }
      for (let index = 0; index < signatures.length; index++) {
        check();
        const reply: Pointer[] = [null];
        checked(native.timeout(bus, remaining(until)));
        try {
          await invoke(
            native.property,
            bus,
            expected ? null : args[1],
            args[2],
            args[3],
            args[index + 4],
            null,
            reply,
            signatures[index],
          );
          check();
          values.push(read(reply[0], signatures[index], budget));
          if (!checked(native.end(reply[0], 0))) {
            throw unavailable();
          }
        } finally {
          if (reply[0]) {
            native.unrefMessage(reply[0]);
          }
        }
      }
    } else {
      const message: Pointer[] = [null],
        reply: Pointer[] = [null];
      const error = Buffer.alloc(native.errorSize);
      try {
        checked(native.newCall(bus, message, expected ? null : args[1], args[2], args[3], args[4]));
        checked(native.autoStart(message[0], 0));
        if (args[5] === "s" && args.length === 7) {
          checked(native.append(message[0], 115, args[6]));
        } else if (args.length !== 5) {
          throw unavailable();
        }
        check();
        try {
          await invoke(native.call, bus, message[0], remaining(until), error, reply);
        } catch (failure) {
          check();
          if (
            (["GetUnit", "LoadUnit"].includes(member) &&
              native.errorHasName(error, "org.freedesktop.systemd1.NoSuchUnit")) ||
            (args[4] === "GetUnitFileState" &&
              (native.errorHasName(error, "org.freedesktop.systemd1.NoSuchUnitFile") ||
                native.errorHasName(error, "org.freedesktop.DBus.Error.FileNotFound")))
          ) {
            return null;
          }
          throw failure;
        }
        check();
        if (signatures.length !== 1) {
          throw unavailable();
        }
        // Method replies retain busctl's top-level tuple, unlike properties.
        values.push([read(reply[0], signatures[0], budget)]);
        if (!checked(native.end(reply[0], 1))) {
          throw unavailable();
        }
      } finally {
        native.errorFree(error);
        if (message[0]) {
          native.unrefMessage(message[0]);
        }
        if (reply[0]) {
          native.unrefMessage(reply[0]);
        }
      }
    }
    check();
    return values;
  };
  return {
    verify,
    close,
    query(args: string[], signatures: string[], until: number, assertCurrent?: () => void) {
      // One sd-bus connection is not thread-safe. Queue within the caller's
      // deadline; a queue wait never earns a new budget or custody interval.
      return queue.run(until, () => execute(args, signatures, until, assertCurrent));
    },
  };
}
