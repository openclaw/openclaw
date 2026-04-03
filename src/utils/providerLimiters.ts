type Task<T> = () => Promise<T> | T;

function makeLimiter(max: number) {
let active = 0;
const q: { task: Task<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
const runNext = () => {
if (active >= max) return;
const next = q.shift();
if (!next) return;
active++;
Promise.resolve()
.then(next.task)
.then(next.resolve, next.reject)
.finally(() => {
active--;
runNext();
});
};
return async <T>(fn: Task<T>): Promise<T> =>
new Promise<T>((resolve, reject) => {
q.push({ task: fn as Task<unknown>, resolve, reject });
runNext();
});
}

const cap = Math.max(1, Number(process.env.LLM_MAX_CONCURRENT || '2'));
const perProvider = new Map<string, ReturnType<typeof makeLimiter>>();

export function withProviderLimiter<T>(provider: 'openai' | 'anthropic', task: Task<T>): Promise<T> {
let lim = perProvider.get(provider);
if (!lim) {
lim = makeLimiter(cap);
perProvider.set(provider, lim);
}
return lim(task);
}
