/** One safe Git branch component, shared by config admission and new repository allocation. */
export const REPOSITORY_BRANCH_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
