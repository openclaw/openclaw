import { escapeRegExp } from "../../utils.js";
import { registerBrowserRoutes } from "./index.js";
function compileRoute(path) {
    const paramNames = [];
    const parts = path.split("/").map((part) => {
        if (part.startsWith(":")) {
            const name = part.slice(1);
            paramNames.push(name);
            return "([^/]+)";
        }
        return escapeRegExp(part);
    });
    return { regex: new RegExp(`^${parts.join("/")}$`), paramNames };
}
function createRegistry() {
    const routes = [];
    const register = (method) => (path, handler) => {
        const { regex, paramNames } = compileRoute(path);
        routes.push({ method, path, regex, paramNames, handler });
    };
    const router = {
        get: register("GET"),
        post: register("POST"),
        delete: register("DELETE"),
    };
    return { routes, router };
}
function normalizePath(path) {
    if (!path) {
        return "/";
    }
    return path.startsWith("/") ? path : `/${path}`;
}
export function createBrowserRouteDispatcher(ctx) {
    const registry = createRegistry();
    registerBrowserRoutes(registry.router, ctx);
    return {
        dispatch: async (req) => {
            const method = req.method;
            const path = normalizePath(req.path);
            const query = req.query ?? {};
            const body = req.body;
            const signal = req.signal;
            const match = registry.routes.find((route) => {
                if (route.method !== method) {
                    return false;
                }
                return route.regex.test(path);
            });
            if (!match) {
                return { status: 404, body: { error: "Not Found" } };
            }
            const exec = match.regex.exec(path);
            const params = {};
            if (exec) {
                for (const [idx, name] of match.paramNames.entries()) {
                    const value = exec[idx + 1];
                    if (typeof value === "string") {
                        try {
                            params[name] = decodeURIComponent(value);
                        }
                        catch {
                            return {
                                status: 400,
                                body: { error: `invalid path parameter encoding: ${name}` },
                            };
                        }
                    }
                }
            }
            let status = 200;
            let payload = undefined;
            const res = {
                status(code) {
                    status = code;
                    return res;
                },
                json(bodyValue) {
                    payload = bodyValue;
                },
            };
            try {
                await match.handler({
                    params,
                    query,
                    body,
                    signal,
                }, res);
            }
            catch (err) {
                return { status: 500, body: { error: String(err) } };
            }
            return { status, body: payload };
        },
    };
}
