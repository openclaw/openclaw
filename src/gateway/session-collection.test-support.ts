export { expectCollected } from "../test-utils/retention.js";

export const weak = (value: object) => new WeakRef(value);
export const weakControl = () => new WeakRef({});
