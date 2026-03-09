import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { useLocation, Link } from "react-router-dom";

export default function NotFound() {
  const location = useLocation();

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="glass-panel p-12 text-center max-w-md"
      >
        <div className="text-6xl font-extralight text-foreground mb-2">404</div>
        <p className="text-text-2 text-sm font-mono mb-1">Route not found</p>
        <p className="text-text-3 text-xs font-mono mb-6">{location.pathname}</p>
        <Link
          to="/office"
          className="glass-pill inline-flex items-center gap-2 px-4 py-2 text-primary text-sm font-medium hover:glow-accent transition-all"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Mission Control
        </Link>
      </motion.div>
    </div>
  );
}
