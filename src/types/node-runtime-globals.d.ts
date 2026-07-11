// The core lane compiles with lib ES2023 (no DOM), so these web-global names
// no longer resolve. Alias them to the canonical Node implementations
// (undici/stream/web) rather than re-adding lib.dom to server code.
type BodyInit = import("undici-types").BodyInit;
type FormDataEntryValue = string | import("node:buffer").File;
type HeadersInit = import("undici-types").HeadersInit;
type ReadableStreamReadResult<T> =
  | import("node:stream/web").ReadableStreamReadDoneResult<T>
  | import("node:stream/web").ReadableStreamReadValueResult<T>;
type RequestCredentials = import("undici-types").RequestCredentials;
type RequestInfo = import("undici-types").RequestInfo;

// Minimal surface for the one compile() caller; WebAssembly types otherwise
// live in lib.dom, which the core lane intentionally excludes.
declare namespace WebAssembly {
  type Module = object;

  function compile(bytes: ArrayBuffer | ArrayBufferView): Promise<Module>;
}
