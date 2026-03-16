// Browser shim for Node.js fs module to prevent accidental bundle crashes.
// This should never be used for real file access in the Control UI.
export const constants = {
  W_OK: 2,
  X_OK: 1,
  O_RDONLY: 0,
  O_NOFOLLOW: 0,
};

const fsShim = { constants };
export default fsShim;
