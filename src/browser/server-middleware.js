import express from "express";
import { browserMutationGuardMiddleware } from "./csrf.js";
import { isAuthorizedBrowserRequest } from "./http-auth.js";
export function installBrowserCommonMiddleware(app) {
    app.use((req, res, next) => {
        const ctrl = new AbortController();
        const abort = () => ctrl.abort(new Error("request aborted"));
        req.once("aborted", abort);
        res.once("close", () => {
            if (!res.writableEnded) {
                abort();
            }
        });
        // Make the signal available to browser route handlers (best-effort).
        req.signal = ctrl.signal;
        next();
    });
    app.use(express.json({ limit: "1mb" }));
    app.use(browserMutationGuardMiddleware());
}
export function installBrowserAuthMiddleware(app, auth) {
    if (!auth.token && !auth.password) {
        return;
    }
    app.use((req, res, next) => {
        if (isAuthorizedBrowserRequest(req, auth)) {
            return next();
        }
        res.status(401).send("Unauthorized");
    });
}
