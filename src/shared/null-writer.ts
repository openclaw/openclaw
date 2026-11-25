import { Writable } from "node:stream";

export function createNullWriter(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
