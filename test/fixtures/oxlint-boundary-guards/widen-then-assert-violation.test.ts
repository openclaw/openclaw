const source = { id: "fixture" };
const widened: unknown = source;
widened as { readonly id: string };

const nestedSource = { id: "nested" };
const nestedWidened: unknown = nestedSource;
nestedWidened as unknown as { readonly id: string };

const aliasSource = { id: "alias" };
const aliasWidened: unknown = aliasSource;
const firstAlias = aliasWidened;
const alias = firstAlias;
alias as { readonly id: string };

let mutableWidened: unknown = source;
mutableWidened as { readonly id: string };

const annotatedAlias: { readonly id: string } = aliasWidened;
annotatedAlias as { readonly id: string };

function readOuterAlias() {
  const innerAlias = aliasWidened;
  return innerAlias as { readonly id: string };
}

forwardAlias as { readonly id: string };
const forwardAlias = aliasWidened;
